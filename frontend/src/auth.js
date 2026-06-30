// Logto auth integration with a Clerk-compatible surface.
//
// The page components (FileViewer, AdminPage, ReportsPage) were written against
// Clerk's `useUser()` / `useAuth()` hooks. To keep that code unchanged, this
// module exposes the same hook shapes but backed by `@logto/react`:
//   - useUser()  -> { user, isLoaded }   with user.publicMetadata.role,
//                                         user.emailAddresses[].emailAddress, etc.
//   - useAuth()  -> { getToken }         returns an access token for the API resource.
//
// User info (email + roles) is fetched once via AuthProvider and shared through
// context so the three components don't each hit the userinfo endpoint.

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useLogto } from '@logto/react';

// The API resource indicator the backend validates against (LOGTO_API_RESOURCE).
// Set on window by App's config loader so these hooks can read it without props.
export function getApiResource() {
  return (typeof window !== 'undefined' && window.__LOGTO_API_RESOURCE__) ||
    process.env.REACT_APP_LOGTO_API_RESOURCE ||
    '';
}

// Permission scopes (RBAC) mapped to roles. Defaults match the backend; the
// authoritative values come from /api/config (window.__RECBOT_ROLE_SCOPES__),
// so the frontend resolves the role exactly as the backend does.
const DEFAULT_ROLE_SCOPES = { admin: 'recbot:admin', manager: 'recbot:manage', member: 'recbot:read' };

function getRoleScopes() {
  return (typeof window !== 'undefined' && window.__RECBOT_ROLE_SCOPES__) || DEFAULT_ROLE_SCOPES;
}

// Decode a JWT payload without verifying (display/role logic only — the backend
// is the real authority and verifies the token on every request).
function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

// Role-name -> app-role map. Defaults match the backend; authoritative values
// come from /api/config (window.__RECBOT_ROLE_NAMES__).
const DEFAULT_ROLE_NAMES = {
  admin: ['admin', 'super admin', 'administrator'],
  manager: ['manager'],
  member: ['member'],
};

function getRoleNames() {
  return (typeof window !== 'undefined' && window.__RECBOT_ROLE_NAMES__) || DEFAULT_ROLE_NAMES;
}

// Map Logto role names to the app's role (admin/manager/member), or undefined.
function roleFromRoleNames(roles) {
  if (!Array.isArray(roles)) return undefined;
  const lower = roles.map(r => String(r?.name ?? r).toLowerCase());
  const map = getRoleNames();
  if (lower.some(r => (map.admin || []).includes(r))) return 'admin';
  if (lower.some(r => (map.manager || []).includes(r))) return 'manager';
  if (lower.some(r => (map.member || []).includes(r))) return 'member';
  return undefined;
}

// Read the app role from the access token's `scope` claim (permissions). The app
// re-authorizes on each load (see AuthProvider) so the scope reflects current
// permissions. Falls back to role names if scopes resolve nothing.
function roleFromAccessToken(token) {
  const payload = decodeJwtPayload(token);
  const scopes = (payload?.scope || '').split(/\s+/).filter(Boolean);
  const map = getRoleScopes();
  if (scopes.includes(map.admin)) return 'admin';
  if (scopes.includes(map.manager)) return 'manager';
  if (scopes.includes(map.member)) return 'member';
  return roleFromRoleNames(payload?.roles);
}

// Shape Logto userinfo claims into the subset of Clerk's user object the app uses.
function shapeUser(info, role) {
  if (!info) return null;
  const email = info.email;
  const verified = info.email_verified !== false; // lenient: only explicit false is unverified
  return {
    id: info.sub,
    firstName: info.given_name || info.name || null,
    lastName: info.family_name || null,
    publicMetadata: { role },
    primaryEmailAddress: { emailAddress: email },
    emailAddresses: [
      {
        emailAddress: email,
        verification: { status: verified ? 'verified' : 'unverified' }
      }
    ]
  };
}

const AuthContext = createContext(null);

// The backend reads the user's email from the ID token. We attach it to every
// same-origin /api/ request via a one-time fetch interceptor, so the ~20 fetch
// call sites don't each need to change. The access token still goes in the
// Authorization header (set by the components via getToken()).
let currentIdTokenGetter = null;
let fetchInterceptorInstalled = false;

function installApiFetchInterceptor() {
  if (fetchInterceptorInstalled || typeof window === 'undefined' || !window.fetch) return;
  fetchInterceptorInstalled = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (currentIdTokenGetter && url.includes('/api/')) {
        const idToken = await currentIdTokenGetter();
        if (idToken) {
          const headers = new Headers((init && init.headers) || {});
          headers.set('X-Id-Token', idToken);
          init = { ...(init || {}), headers };
        }
      }
    } catch (e) {
      // fall through and send the request without the ID token header
    }
    return originalFetch(input, init);
  };
}

// sessionStorage keys for the re-authorization round-trip (see AuthProvider).
const REAUTH_DONE_KEY = 'logto_reauthed';
const REAUTH_PATH_KEY = 'logto_return_path';

export function AuthProvider({ children }) {
  const { isAuthenticated, isLoading, fetchUserInfo, getAccessToken, getIdToken, signIn } = useLogto();
  const [user, setUser] = useState(null);
  const [infoLoaded, setInfoLoaded] = useState(false);
  // Whether the role lookup has completed — gates the unauthorized check so a
  // user with a role doesn't briefly see "unauthorized" while the role resolves.
  const [roleResolved, setRoleResolved] = useState(false);

  // Keep the SDK functions in a ref so the effect below can call them without
  // listing them as deps — their identities change every render, and depending
  // on them would re-run the effect (and re-hit /oidc/me + /oidc/token) in a loop.
  const logtoRef = useRef({ fetchUserInfo, getAccessToken, getIdToken, signIn });
  logtoRef.current = { fetchUserInfo, getAccessToken, getIdToken, signIn };

  // Expose the current ID token to the fetch interceptor and install it once.
  useEffect(() => {
    currentIdTokenGetter = () => logtoRef.current.getIdToken?.();
    installApiFetchInterceptor();
  }, []);

  // Load userinfo exactly once per authenticated session. Even if the SDK's
  // isLoading/isAuthenticated toggle and re-run this effect, this prevents
  // re-hitting /oidc/me in a loop. Reset when the user signs out.
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (isLoading) return;
    // On the OIDC callback route, let the Callback component finish the exchange
    // and redirect; don't run the re-auth logic here (would race into a loop).
    if (typeof window !== 'undefined' && window.location.pathname === '/callback') return;
    if (!isAuthenticated) {
      fetchedRef.current = false;
      setUser(null);
      setInfoLoaded(true);
      setRoleResolved(false);
      return;
    }
    // Fetch once per authenticated session. We deliberately do NOT cancel the
    // in-flight fetch on cleanup: if isLoading/isAuthenticated toggle once after
    // sign-in, cancelling would discard the result while fetchedRef blocks any
    // retry — leaving infoLoaded false forever (endless spinner). AuthProvider
    // is a stable top-level provider that doesn't unmount, so letting the fetch
    // complete is safe.
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    // Re-authorize against Logto once per page load to obtain a token with the
    // user's CURRENT scopes. A plain refresh can't add scopes granted after
    // login, so we go through the authorization endpoint — Logto reuses the
    // active session, making this a fast redirect with no login prompt. Guarded
    // by a sessionStorage flag so it runs once (not in a loop), and returns to
    // the same page.
    if (sessionStorage.getItem(REAUTH_DONE_KEY) !== '1') {
      try {
        sessionStorage.setItem(REAUTH_PATH_KEY, window.location.pathname + window.location.search);
        logtoRef.current.signIn(`${window.location.origin}/callback`);
        return; // redirecting to Logto for a fresh-scope token
      } catch (e) {
        console.warn('Re-authorization failed; continuing with current token', e);
      }
    }
    sessionStorage.removeItem(REAUTH_DONE_KEY);

    (async () => {
      // 1) Load email from userinfo (reliable in the browser) and mark loaded.
      //    Role is resolved separately below so it can't block rendering.
      try {
        const info = await logtoRef.current.fetchUserInfo();
        setUser(shapeUser(info, undefined));
      } catch (e) {
        console.error('Failed to fetch user info from Logto', e);
        setUser(null);
      } finally {
        setInfoLoaded(true);
      }

      // 2) Resolve role from the fresh access token's `scope` claim. Always
      //    mark roleResolved so the gate can decide authorized vs. unauthorized.
      let role;
      const resource = getApiResource();
      if (resource) {
        try {
          const token = await logtoRef.current.getAccessToken(resource);
          role = roleFromAccessToken(token);
        } catch (e) {
          console.warn('Could not read role from access token', e);
        }
      }
      setUser(prev => (prev ? { ...prev, publicMetadata: { role } } : prev));
      setRoleResolved(true);
    })();
    // Intentionally only re-run when auth state changes, not on SDK fn identity.
  }, [isAuthenticated, isLoading]);

  // While signed in but without a role (the "Not Authorized" screen), reload
  // periodically so the re-authorization on load picks up a role that an admin
  // grants in Logto — the user gains access automatically without knowing to
  // refresh. A token refresh can't add new scopes, so a full reload (which
  // re-authorizes) is what's needed. Stops once a role is present.
  const hasRole = !!user?.publicMetadata?.role;
  useEffect(() => {
    if (!isAuthenticated || !roleResolved || hasRole) return;
    const RECHECK_MS = 20000; // reload (re-authorize) every 20s while unauthorized
    const timer = setTimeout(() => {
      if (typeof window !== 'undefined') window.location.reload();
    }, RECHECK_MS);
    return () => clearTimeout(timer);
  }, [isAuthenticated, roleResolved, hasRole]);

  // Once userinfo has loaded, stay "loaded" even if the SDK briefly toggles
  // isLoading again (background token refresh) — otherwise the app would flip
  // back to a spinner mid-session.
  const isLoaded = infoLoaded;

  return (
    <AuthContext.Provider value={{ user, isLoaded, isAuthenticated, roleResolved }}>
      {children}
    </AuthContext.Provider>
  );
}

// Clerk-compatible: useUser() -> { user, isLoaded } (+ roleResolved extension)
export function useUser() {
  const ctx = useContext(AuthContext);
  if (!ctx) return { user: null, isLoaded: false, roleResolved: false };
  return { user: ctx.user, isLoaded: ctx.isLoaded, roleResolved: ctx.roleResolved };
}

// Clerk-compatible: useAuth() -> { getToken }
// getToken has a STABLE identity across renders (via a ref) so the page
// components' fetch effects that list it as a dependency don't re-fire on every
// render. The Logto SDK caches access tokens, so repeated calls don't hit the
// network unless the token has expired.
export function useAuth() {
  const { getAccessToken, isAuthenticated } = useLogto();
  const ref = useRef({ getAccessToken, isAuthenticated });
  ref.current = { getAccessToken, isAuthenticated };

  const getToken = useCallback(async () => {
    const { getAccessToken, isAuthenticated } = ref.current;
    if (!isAuthenticated) return null;
    try {
      // Resource access token (JWT) — the backend verifies it and reads the
      // email/roles claims from it.
      return await getAccessToken(getApiResource());
    } catch (e) {
      console.error('Failed to get Logto access token', e);
      return null;
    }
  }, []);

  return { getToken };
}

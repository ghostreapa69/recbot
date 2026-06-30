import { createRemoteJWKSet, jwtVerify } from 'jose';
import { logUserSession, logAuditEvent, getLastLogin, getUserSessions, linkLogtoIdentity, getEmailByLogtoId } from './database.js';

// Cache of Logto user id -> email, so the email-by-sub fallback (used for
// ?auth= media URLs that can't send the ID token) doesn't hit the DB each time.
const emailBySubCache = new Map();

// ============================================================
// Logto configuration
// ============================================================
const LOGTO_ENDPOINT = (process.env.LOGTO_ENDPOINT || '').replace(/\/+$/, '');
const LOGTO_API_RESOURCE = process.env.LOGTO_API_RESOURCE || '';
// The SPA app ID = the ID token's audience. Used to verify the ID token that
// carries the user's email (the access token carries roles but not email).
const LOGTO_APP_ID = process.env.LOGTO_APP_ID || '';

if (!LOGTO_ENDPOINT) {
  console.error('❌ LOGTO_ENDPOINT environment variable is required (e.g. https://your-tenant.logto.app)');
  process.exit(1);
}

if (!LOGTO_API_RESOURCE) {
  console.error('❌ LOGTO_API_RESOURCE environment variable is required (the API resource indicator, e.g. https://recbot.api)');
  process.exit(1);
}

const LOGTO_ISSUER = `${LOGTO_ENDPOINT}/oidc`;
const LOGTO_JWKS_URL = new URL(`${LOGTO_ENDPOINT}/oidc/jwks`);
const LOGTO_USERINFO_URL = `${LOGTO_ENDPOINT}/oidc/me`;

// Remote JWKS with built-in caching/rotation handling.
const jwks = createRemoteJWKSet(LOGTO_JWKS_URL);

// Map RBAC permission scopes (assigned to roles on the API resource) to the
// app's role names. Override the scope strings via env if your Logto setup
// uses different permission names.
const SCOPE_ADMIN = process.env.LOGTO_SCOPE_ADMIN || 'recbot:admin';
const SCOPE_MANAGER = process.env.LOGTO_SCOPE_MANAGER || 'recbot:manage';
const SCOPE_MEMBER = process.env.LOGTO_SCOPE_MEMBER || 'recbot:read';

// Exposed to the frontend via /api/config so it requests exactly these scopes
// and resolves the role from the access token's `scope` claim the same way.
export const ROLE_SCOPES = {
  admin: SCOPE_ADMIN,
  manager: SCOPE_MANAGER,
  member: SCOPE_MEMBER,
};

function roleFromScopes(scopeString) {
  const scopes = (scopeString || '').split(/\s+/).filter(Boolean);
  if (scopes.includes(SCOPE_ADMIN)) return 'admin';
  if (scopes.includes(SCOPE_MANAGER)) return 'manager';
  if (scopes.includes(SCOPE_MEMBER)) return 'member';
  return null;
}

// Fallback: derive role from Logto role NAMES (the token's `roles` claim) when
// permission scopes aren't configured yet. Configurable via env (comma-separated,
// case-insensitive) so it matches whatever your Logto roles are called.
function parseRoleList(raw, fallback) {
  const value = (typeof raw === 'string' && raw.trim()) ? raw : fallback;
  return value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

const ROLE_NAME_ADMIN = parseRoleList(process.env.LOGTO_ADMIN_ROLES, 'admin,super admin,administrator');
const ROLE_NAME_MANAGER = parseRoleList(process.env.LOGTO_MANAGER_ROLES, 'manager');
const ROLE_NAME_MEMBER = parseRoleList(process.env.LOGTO_MEMBER_ROLES, 'member');

// Exposed to the frontend via /api/config so it resolves the role from the
// token's `roles` claim the same way the backend does.
export const ROLE_NAMES = {
  admin: ROLE_NAME_ADMIN,
  manager: ROLE_NAME_MANAGER,
  member: ROLE_NAME_MEMBER,
};

function roleFromRoleNames(roles) {
  if (!Array.isArray(roles)) return null;
  const lower = roles.map(r => String(r?.name ?? r).toLowerCase());
  if (lower.some(r => ROLE_NAME_ADMIN.includes(r))) return 'admin';
  if (lower.some(r => ROLE_NAME_MANAGER.includes(r))) return 'manager';
  if (lower.some(r => ROLE_NAME_MEMBER.includes(r))) return 'member';
  return null;
}

console.log(`[AUTH CONFIG] Logto issuer: ${LOGTO_ISSUER}, API resource: ${LOGTO_API_RESOURCE}`);

// ============================================================
// Allowed login identifiers (domain / email allowlist) — unchanged
// ============================================================
const DEFAULT_ALLOWED_LOGIN_IDENTIFIERS = ['mtgpros.com'];

function parseAllowedLoginIdentifiers(rawValue, fallbackList = DEFAULT_ALLOWED_LOGIN_IDENTIFIERS) {
  const hasRawValue = typeof rawValue === 'string' && rawValue.trim().length > 0;
  const baseValue = hasRawValue
    ? rawValue
    : (Array.isArray(fallbackList) && fallbackList.length ? fallbackList.join(',') : '');

  if (!baseValue) {
    return { allowAll: false, entries: [] };
  }

  const tokens = baseValue
    .split(',')
    .map(part => (typeof part === 'string' ? part.trim().toLowerCase() : ''))
    .filter(Boolean);

  const allowAll = tokens.includes('*');
  const entries = allowAll ? tokens.filter(token => token !== '*') : tokens;

  return { allowAll, entries: Array.from(new Set(entries)) };
}

const rawAllowedLoginValue = process.env.ALLOWED_LOGIN_IDENTIFIERS ?? process.env.ALLOWED_EMAIL_DOMAIN ?? '';
const parsedAllowedLoginConfig = parseAllowedLoginIdentifiers(rawAllowedLoginValue);

export const allowedLoginConfig = Object.freeze({
  allowAll: parsedAllowedLoginConfig.allowAll,
  entries: Object.freeze(parsedAllowedLoginConfig.entries)
});

if (!allowedLoginConfig.allowAll && allowedLoginConfig.entries.length === 0) {
  console.warn('⚠️  [AUTH CONFIG] No allowed login identifiers configured; all sign-ins will be rejected.');
}

console.log(
  `[AUTH CONFIG] Allowed login identifiers: ${
    allowedLoginConfig.allowAll
      ? '* (all verified emails permitted)'
      : allowedLoginConfig.entries.join(', ') || '(none)'
  }`
);

const matchesAllowedIdentifier = (email, identifier) => {
  if (!email || !identifier) return false;
  if (!identifier.includes('@')) {
    return email.endsWith(`@${identifier}`);
  }
  if (identifier.startsWith('@') && identifier.indexOf('@', 1) === -1) {
    return email.endsWith(identifier);
  }
  return email === identifier;
};

export const isEmailAllowed = (email) => {
  if (!email) return false;
  const normalized = email.toLowerCase();
  if (allowedLoginConfig.allowAll) return true;
  if (!allowedLoginConfig.entries.length) return false;
  return allowedLoginConfig.entries.some(identifier => matchesAllowedIdentifier(normalized, identifier));
};

// ============================================================
// Token + userinfo helpers
// ============================================================
function extractBearerToken(req) {
  const header = req.headers['authorization'] || req.headers['Authorization'];
  if (header && typeof header === 'string') {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  // Media/download URLs (e.g. a native <audio> src) can't set headers, so the
  // access token is passed as a ?auth= query param.
  if (req.query && typeof req.query.auth === 'string' && req.query.auth) {
    return req.query.auth;
  }
  return null;
}

// Verify the ID token (sent by the frontend in the X-Id-Token header) and
// return its claims. The ID token carries the user's email; its audience is the
// SPA app id. Signed by the same Logto keys as the access token.
async function verifyIdToken(idToken) {
  if (!idToken) return null;
  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: LOGTO_ISSUER,
      // Only enforce audience if we know the app id; signature + issuer already
      // prove the token came from our Logto.
      ...(LOGTO_APP_ID ? { audience: LOGTO_APP_ID } : {}),
    });
    return payload;
  } catch (e) {
    console.log(`🚫 [AUTH] ID token verification failed: ${e.message}`);
    return null;
  }
}

// Short-lived cache of userinfo keyed by access token, so we don't call Logto's
// userinfo endpoint on every authenticated API request (the same access token is
// reused by the client until it expires, typically ~1h).
const USERINFO_TTL_MS = parseInt(process.env.LOGTO_USERINFO_TTL_MS || '300000', 10); // 5 min
const userInfoCache = new Map(); // accessToken -> { info, expiresAt }

function pruneUserInfoCache(now) {
  for (const [key, entry] of userInfoCache) {
    if (entry.expiresAt <= now) userInfoCache.delete(key);
  }
}

// Fetch the user's profile (email, verification, optional role names) from
// Logto's OIDC userinfo endpoint using the same access token. Mirrors the role
// previously played by clerkClient.users.getUser(). Cached per token.
async function fetchUserInfo(accessToken) {
  const now = Date.now();
  const cached = userInfoCache.get(accessToken);
  if (cached && cached.expiresAt > now) {
    return cached.info;
  }

  const resp = await fetch(LOGTO_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!resp.ok) {
    throw new Error(`Logto userinfo request failed: ${resp.status} ${resp.statusText}`);
  }
  const info = await resp.json();

  userInfoCache.set(accessToken, { info, expiresAt: now + USERINFO_TTL_MS });
  if (userInfoCache.size > 2000) pruneUserInfoCache(now);

  return info;
}

// ============================================================
// No-op middleware kept so existing `app.use(logtoAuth)` wiring stays valid.
// Token verification happens per-route in requireAuth (tokens arrive as
// Authorization: Bearer headers, so no global session middleware is needed).
// ============================================================
export const logtoAuth = (req, res, next) => next();

// Middleware to ensure user is authenticated and populate user data
export const requireAuth = async (req, res, next) => {
  try {
    const accessToken = extractBearerToken(req);

    if (!accessToken) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Verify the resource access token (JWT) against Logto's JWKS, issuer and
    // API audience. Identity (sub), roles and email are read directly from the
    // verified claims — no userinfo round trip. `roles` and `email` must be
    // added as Custom JWT claims in Logto for the API resource access token.
    let payload;
    try {
      ({ payload } = await jwtVerify(accessToken, jwks, {
        issuer: LOGTO_ISSUER,
        audience: LOGTO_API_RESOURCE,
      }));
    } catch (verifyError) {
      console.log(`🚫 [AUTH] Token verification failed: ${verifyError.message}`);
      return res.status(401).json({ error: 'Authentication required' });
    }

    const logtoUserId = payload.sub;
    if (!logtoUserId) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Roles come from the access token; email comes from the ID token (sent in
    // the X-Id-Token header), since the access token doesn't carry email.
    const roleNames = payload.roles;

    let userEmail = payload.email;
    let isEmailVerified = payload.email_verified !== false;

    if (!userEmail) {
      const idTokenHeader = req.headers['x-id-token'];
      const idClaims = await verifyIdToken(typeof idTokenHeader === 'string' ? idTokenHeader : null);
      if (idClaims) {
        // Guard against a mismatched token pair.
        if (idClaims.sub && idClaims.sub !== logtoUserId) {
          console.log(`🚫 [AUTH] ID token subject (${idClaims.sub}) does not match access token (${logtoUserId})`);
          return res.status(401).json({ error: 'Authentication failed' });
        }
        userEmail = idClaims.email;
        isEmailVerified = idClaims.email_verified !== false;
      }
    }

    // Fallback for requests that can't send the ID token header (native <audio>
    // ?auth= URLs, downloads): resolve email by sub from a prior login. The
    // access token is already cryptographically verified above.
    if (!userEmail) {
      userEmail = emailBySubCache.get(logtoUserId);
      if (!userEmail) {
        userEmail = await getEmailByLogtoId(logtoUserId);
      }
    }

    if (!userEmail) {
      console.error('🚫 [AUTH] No email found — no email claim, no ID token, and no prior identity-map entry for this user.');
      return res.status(401).json({
        error: 'Authentication failed',
        message: 'Email not available for this session.'
      });
    }

    // Remember email for this user so subsequent ?auth= requests skip the DB lookup.
    emailBySubCache.set(logtoUserId, userEmail);

    if (!isEmailAllowed(userEmail)) {
      const attemptedEmail = userEmail || '<missing email>';
      console.log(`🚫 [AUTH ACCESS DENIED] User ${attemptedEmail} attempted access - not on allowed login list`);
      return res.status(403).json({
        error: 'Access denied',
        message: 'Your email address is not authorized to access this application.'
      });
    }

    // EMAIL VERIFICATION: Require verified email
    if (!isEmailVerified) {
      console.log(`🚫 [EMAIL NOT VERIFIED] User ${userEmail} attempted access - email not verified`);
      return res.status(403).json({
        error: 'Email verification required',
        message: 'Please verify your email address to access this application'
      });
    }

    // Resolve role from the access token's permission `scope` claim (Logto RBAC).
    // The frontend re-authorizes against Logto on each load to mint a token with
    // current scopes, so permission changes apply on refresh. Role NAMES are an
    // opt-in fallback only (LOGTO_USE_ROLE_NAMES=true).
    const useRoleNames = /^true$/i.test(process.env.LOGTO_USE_ROLE_NAMES || '');
    const role = roleFromScopes(payload.scope)
      || (useRoleNames ? roleFromRoleNames(roleNames) : null)
      || null;

    // No recbot role/permission => not authorized to use the application.
    if (!role) {
      console.log(`🚫 [AUTH ACCESS DENIED] User ${userEmail} has no application role. scope=${payload.scope ?? '(none)'} roles=${JSON.stringify(roleNames)}`);
      return res.status(403).json({
        error: 'No role assigned',
        message: 'You do not have a role for this application. Please contact your administrator.'
      });
    }

    console.log(`✅ [AUTH ACCESS] User ${userEmail} granted access (role=${role}, scope="${payload.scope ?? ''}", roles=${JSON.stringify(payload.roles ?? null)})`);

    // Relink any historical logs (old Clerk user IDs) to this Logto user ID.
    // Idempotent and cheap after the first successful link per user.
    try {
      await linkLogtoIdentity(logtoUserId, userEmail);
    } catch (linkError) {
      console.warn('Identity link step failed (continuing):', linkError.message);
    }

    // Get client IP and user agent for audit logging
    const ipAddress = req.realClientIP || req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    console.log(`🔐 [AUTH] Client IP: ${ipAddress}, User Agent: ${userAgent.substring(0, 50)}...`);

    // Determine if there is an existing open session (logout_time NULL); if not, create one & log LOGIN
    let openSessionExists = false;
    try {
      const recent = await getUserSessions(logtoUserId, null, null, 5, 0);
      openSessionExists = recent.some(s => !s.logout_time);
    } catch (e) {
      console.warn('Could not determine open session state, proceeding to create new session:', e.message);
    }
    if (!openSessionExists) {
      const now = new Date();
      const lastLogin = await getLastLogin(logtoUserId);
      await logUserSession(logtoUserId, userEmail, ipAddress, userAgent);
      await logAuditEvent(logtoUserId, userEmail, 'LOGIN', null, null, ipAddress, userAgent, null, {
        lastLogin,
        loginTime: now.toISOString(),
        reason: 'new_session_no_open_session'
      });
    }

    // Add user info to request for easier access
    req.user = {
      id: logtoUserId,
      email: userEmail,
      role,
      firstName: payload.given_name || payload.name || null,
      lastName: payload.family_name || null,
      ipAddress: ipAddress,  // Real client IP (from realClientIP)
      userAgent: userAgent
    };

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

// Middleware to check if user has admin role
export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
};

// Middleware to check if user has member or admin role
export const requireMemberOrAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  if (!req.user.role || (req.user.role !== 'admin' && req.user.role !== 'member')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
};

// Simplified middleware - any authenticated user can access
export const requireAuthenticatedUser = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  next();
};

// Middleware for manager/admin access (for downloads, etc.)
export const requireManagerOrAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  if (!req.user.role || (req.user.role !== 'admin' && req.user.role !== 'manager')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
};

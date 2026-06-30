import React, { useState, useEffect } from "react";
import { LogtoProvider, useLogto, useHandleSignInCallback, UserScope } from '@logto/react';
import { BrowserRouter as Router, Routes, Route, Navigate, Link } from 'react-router-dom';
import {
  AppBar,
  Toolbar,
  Typography,
  Box,
  Switch,
  FormControlLabel,
  CssBaseline,
  Button,
  Container,
  Paper,
  Alert,
} from "@mui/material";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import FileViewer from './FileViewer';
import AdminPage from './AdminPage';
import ReportsPage from './ReportsPage';
import { AuthProvider, useUser, useAuth } from './auth';

// Build-time env fallbacks; runtime values come from /api/config.
const ENV_LOGTO_ENDPOINT = process.env.REACT_APP_LOGTO_ENDPOINT;
const ENV_LOGTO_APP_ID = process.env.REACT_APP_LOGTO_APP_ID;
const ENV_LOGTO_API_RESOURCE = process.env.REACT_APP_LOGTO_API_RESOURCE;

const DEFAULT_ALLOWED_LOGIN_IDENTIFIERS = ['mtgpros.com'];

// Scopes requested from Logto: profile + email (for the allowlist/verification
// checks). The role is derived from the API access token's permission scopes
// (see auth.js), so we do NOT request the `roles` user scope — some Logto
// setups reject it with invalid_scope.
const LOGTO_SCOPES = [UserScope.Email, UserScope.Profile];

const SIGN_IN_REDIRECT_URI = `${window.location.origin}/callback`;
const POST_SIGN_OUT_REDIRECT_URI = `${window.location.origin}/`;

function parseAllowedIdentifiers(value, fallbackList = DEFAULT_ALLOWED_LOGIN_IDENTIFIERS) {
  const hasValue = typeof value === 'string' && value.trim().length > 0;
  const base = hasValue
    ? value
    : (Array.isArray(fallbackList) && fallbackList.length ? fallbackList.join(',') : '');

  if (!base) {
    return { allowAll: false, entries: [] };
  }

  const tokens = base
    .split(',')
    .map(part => (typeof part === 'string' ? part.trim().toLowerCase() : ''))
    .filter(Boolean);

  const allowAll = tokens.includes('*');
  const entries = allowAll ? tokens.filter(token => token !== '*') : tokens;

  return {
    allowAll,
    entries: Array.from(new Set(entries))
  };
}

function normalizeAllowedLoginConfig(source, fallbackList = DEFAULT_ALLOWED_LOGIN_IDENTIFIERS) {
  if (typeof source === 'string' || source === undefined || source === null) {
    return parseAllowedIdentifiers(source || '', fallbackList);
  }

  if (typeof source === 'object') {
    const allowAll = Boolean(source.allowAll);
    const rawEntries = Array.isArray(source.entries) ? source.entries : [];
    const entries = rawEntries
      .map(entry => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
      .filter(Boolean);
    return {
      allowAll,
      entries: allowAll ? entries.filter(entry => entry !== '*') : Array.from(new Set(entries))
    };
  }

  return parseAllowedIdentifiers('', fallbackList);
}

function matchesAllowedIdentifier(email, identifier) {
  if (!email || !identifier) return false;
  if (!identifier.includes('@')) {
    return email.endsWith(`@${identifier}`);
  }
  if (identifier.startsWith('@') && identifier.indexOf('@', 1) === -1) {
    return email.endsWith(identifier);
  }
  return email === identifier;
}

const ENV_ALLOWED_LOGIN_CONFIG = normalizeAllowedLoginConfig(process.env.REACT_APP_ALLOWED_LOGIN_IDENTIFIERS);

// Small reusable sign-out button for the access-denied / unverified screens.
function SignOutButton({ children = 'Sign out' }) {
  const { signOut } = useLogto();
  return (
    <Button variant="outlined" size="small" onClick={() => signOut(POST_SIGN_OUT_REDIRECT_URI)}>
      {children}
    </Button>
  );
}

// Domain validation component
function DomainValidator({ children, allowedLoginConfig }) {
  const { user, isLoaded, roleResolved } = useUser();

  if (!isLoaded) {
    return <div>Loading...</div>;
  }

  const config = normalizeAllowedLoginConfig(allowedLoginConfig);
  const allowedEntries = config.entries;
  const allowAll = config.allowAll;
  const userEmail = user?.emailAddresses?.[0]?.emailAddress;
  const isEmailVerified = user?.emailAddresses?.[0]?.verification?.status === 'verified';
  const normalizedEmail = userEmail ? userEmail.toLowerCase() : null;
  const emailIsAllowed = allowAll || (normalizedEmail && allowedEntries.some(identifier => matchesAllowedIdentifier(normalizedEmail, identifier)));

  if (!emailIsAllowed) {
    return (
      <Container maxWidth="md" sx={{ mt: 8 }}>
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Alert severity="error" sx={{ mb: 3 }}>
            <Typography variant="h5" gutterBottom>
              Access Denied
            </Typography>
            <Typography variant="body1" paragraph>
              You are not allowed to access this application.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Your current email: <strong>{userEmail || 'No email found'}</strong>
            </Typography>
          </Alert>
          <Box sx={{ mt: 3 }}>
            <Typography variant="body2" color="text.secondary" paragraph>
              If you believe this is an error, please contact your administrator.
            </Typography>
            <SignOutButton />
          </Box>
        </Paper>
      </Container>
    );
  }

  if (!isEmailVerified) {
    return (
      <Container maxWidth="md" sx={{ mt: 8 }}>
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Alert severity="warning" sx={{ mb: 3 }}>
            <Typography variant="h5" gutterBottom>
              Email Verification Required
            </Typography>
            <Typography variant="body1" paragraph>
              Please verify your email address to access this application.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Your email: <strong>{userEmail}</strong> needs to be verified.
            </Typography>
          </Alert>
          <Box sx={{ mt: 3 }}>
            <Typography variant="body2" color="text.secondary" paragraph>
              Check your email for a verification link, or contact your administrator if you need assistance.
            </Typography>
            <SignOutButton />
          </Box>
        </Paper>
      </Container>
    );
  }

  // Wait for the role lookup before deciding authorized vs. unauthorized, so a
  // user who has a role doesn't briefly flash the unauthorized screen.
  if (!roleResolved) {
    return <div>Loading...</div>;
  }

  // No recbot role (none of admin/manager/member) => not authorized.
  const role = user?.publicMetadata?.role;
  if (!role) {
    return (
      <Container maxWidth="md" sx={{ mt: 8 }}>
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Alert severity="error" sx={{ mb: 3 }}>
            <Typography variant="h5" gutterBottom>
              Not Authorized
            </Typography>
            <Typography variant="body1" paragraph>
              Your account does not have a role for this application.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Signed in as: <strong>{userEmail}</strong>
            </Typography>
          </Alert>
          <Box sx={{ mt: 3 }}>
            <Typography variant="body2" color="text.secondary" paragraph>
              Please contact your administrator to be granted access.
            </Typography>
            <SignOutButton />
          </Box>
        </Paper>
      </Container>
    );
  }

  // User has valid allowlist match, verified email, and a role — render the app
  return children;
}

function Navigation({ darkMode, setDarkMode }) {
  const { user } = useUser();
  const { signOut } = useLogto();
  const { getToken } = useAuth();
  const isAdmin = user?.publicMetadata?.role === 'admin';
  const isManager = user?.publicMetadata?.role === 'manager';

  const handleLogout = async () => {
    try {
      const token = await getToken();
      await fetch('/api/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      });
    } catch (e) {
      console.error('Failed to record logout', e);
    } finally {
      signOut(POST_SIGN_OUT_REDIRECT_URI);
    }
  };

  return (
    <AppBar position="static" color="default" elevation={1}>
      <Toolbar>
        <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
          MTGPros Five9 Recordings
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {isAdmin && (
            <Button component={Link} to="/admin" variant="outlined" size="small">
              Admin Dashboard
            </Button>
          )}
          {!isAdmin && isManager && (
            <Button component={Link} to="/admin" variant="outlined" size="small">
              Reporting
            </Button>
          )}

          <Button component={Link} to="/" variant="text" size="small">
            Recordings
          </Button>
          <Button component={Link} to="/reports" variant="text" size="small">
            Reports
          </Button>

          <FormControlLabel
            control={<Switch checked={darkMode} onChange={(e) => setDarkMode(e.target.checked)} />}
            label="Dark Mode"
          />

          <Button variant="outlined" size="small" color="error" onClick={handleLogout}>Logout</Button>
        </Box>
      </Toolbar>
    </AppBar>
  );
}

function LoadingScreen({ text = 'Loading...' }) {
  return (
    <Container maxWidth="sm" sx={{ mt: 8 }}>
      <Box sx={{ textAlign: 'center', p: 4 }}>
        <Typography variant="h6">{text}</Typography>
      </Box>
    </Container>
  );
}

// Handles the OIDC redirect back from Logto at /callback.
function Callback() {
  const { error } = useHandleSignInCallback(() => {
    // Mark that we just re-authorized (so AuthProvider doesn't immediately
    // re-authorize again — prevents a redirect loop) and return to the page the
    // user was on before the round-trip.
    sessionStorage.setItem('logto_reauthed', '1');
    const returnPath = sessionStorage.getItem('logto_return_path') || '/';
    sessionStorage.removeItem('logto_return_path');
    window.location.replace(returnPath);
  });

  if (error) {
    return (
      <Container maxWidth="sm" sx={{ mt: 8 }}>
        <Box sx={{ textAlign: 'center', p: 4, bgcolor: 'error.light', borderRadius: 2 }}>
          <Typography variant="h5" color="error" gutterBottom>⚠️ Sign-in Error</Typography>
          <Typography variant="body1">{error.message || String(error)}</Typography>
        </Box>
      </Container>
    );
  }

  return <LoadingScreen text="Completing sign-in..." />;
}

function SignInScreen() {
  const { signIn } = useLogto();
  return (
    <Container maxWidth="sm" sx={{ mt: 8 }}>
      <Typography variant="h4" gutterBottom align="center">
        MTGPros Five9 Recordings
      </Typography>
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
        <Button variant="contained" size="large" onClick={() => signIn(SIGN_IN_REDIRECT_URI)}>
          Sign in
        </Button>
      </Box>
    </Container>
  );
}

function AppContent({ allowedLoginConfig }) {
  const { isAuthenticated, isLoading } = useLogto();
  const [darkMode, setDarkMode] = useState(localStorage.getItem('darkMode') === 'true');

  useEffect(() => {
    localStorage.setItem('darkMode', darkMode);
  }, [darkMode]);

  const theme = createTheme({
    palette: { mode: darkMode ? "dark" : "light" },
  });

  // Handle the OIDC callback before any auth gating.
  const isCallback = typeof window !== 'undefined' && window.location.pathname === '/callback';

  let body;
  if (isCallback) {
    body = <Callback />;
  } else if (isAuthenticated) {
    // Authenticated: render the app and IGNORE isLoading. The Logto SDK toggles
    // isLoading during background token refreshes; gating on it here would
    // unmount/remount the whole app subtree (and re-fire every mount fetch) on
    // each refresh — a request storm. Only use isLoading for the first load.
    body = (
      <Router>
        <DomainValidator allowedLoginConfig={allowedLoginConfig}>
          <Navigation darkMode={darkMode} setDarkMode={setDarkMode} />
          <Routes>
            <Route path="/" element={<FileViewer darkMode={darkMode} />} />
            <Route path="/admin" element={<AdminPage darkMode={darkMode} />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </DomainValidator>
      </Router>
    );
  } else if (isLoading) {
    body = <LoadingScreen />;
  } else {
    body = <SignInScreen />;
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        {body}
      </LocalizationProvider>
    </ThemeProvider>
  );
}

function LogtoConfigLoader() {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/config')
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;

        const endpoint = data.logtoEndpoint || ENV_LOGTO_ENDPOINT;
        const appId = data.logtoAppId || ENV_LOGTO_APP_ID;
        const apiResource = data.logtoApiResource || ENV_LOGTO_API_RESOURCE || '';

        if (endpoint && appId) {
          // Expose the API resource for the auth hooks' getAccessToken().
          window.__LOGTO_API_RESOURCE__ = apiResource;
          // Expose the role mappings so the frontend resolves the role the same
          // way the backend does (keeps the admin UI in sync). roleNames is the
          // live source (token `roles` claim); roleScopes kept for compatibility.
          if (data.roleScopes) window.__RECBOT_ROLE_SCOPES__ = data.roleScopes;
          if (data.roleNames) window.__RECBOT_ROLE_NAMES__ = data.roleNames;

          const serverAllowedConfig = data.allowedLoginConfig
            ? normalizeAllowedLoginConfig(
                data.allowedLoginConfig,
                ENV_ALLOWED_LOGIN_CONFIG.entries.length ? ENV_ALLOWED_LOGIN_CONFIG.entries : DEFAULT_ALLOWED_LOGIN_IDENTIFIERS
              )
            : ENV_ALLOWED_LOGIN_CONFIG;

          // Request the API permission scopes from the server so the access
          // token's `scope` claim carries the user's granted permissions.
          const apiScopes = Array.isArray(data.apiScopes) ? data.apiScopes : [];

          setConfig({
            logto: {
              endpoint,
              appId,
              resources: apiResource ? [apiResource] : [],
              scopes: [...LOGTO_SCOPES, ...apiScopes],
            },
            allowedLoginConfig: serverAllowedConfig
          });
        } else {
          setError('Logto configuration is not available from the server.');
        }
      })
      .catch(err => {
        if (cancelled) return;
        console.error('Failed to load config:', err);
        setError('Failed to load configuration');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <LoadingScreen text="Loading configuration..." />;
  }

  if (error || !config) {
    return (
      <Container maxWidth="sm" sx={{ mt: 8 }}>
        <Box sx={{ textAlign: 'center', p: 4, bgcolor: 'error.light', borderRadius: 2 }}>
          <Typography variant="h5" color="error" gutterBottom>
            ⚠️ Configuration Error
          </Typography>
          <Typography variant="body1" sx={{ mb: 2 }}>
            {error || 'Logto is not configured.'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Please set LOGTO_ENDPOINT and LOGTO_APP_ID in your server environment variables.
          </Typography>
        </Box>
      </Container>
    );
  }

  return (
    <LogtoProvider config={config.logto}>
      <AuthProvider>
        <AppContent allowedLoginConfig={config.allowedLoginConfig} />
      </AuthProvider>
    </LogtoProvider>
  );
}

function App() {
  return <LogtoConfigLoader />;
}

export default App;

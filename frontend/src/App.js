import React, { useState, useEffect } from "react";
import { ClerkProvider, SignIn, SignUp, SignedIn, SignedOut, UserButton, useUser, useClerk } from '@clerk/clerk-react';
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

// Try build-time env var first, then runtime config
const CLERK_PUBLISHABLE_KEY = process.env.REACT_APP_CLERK_PUBLISHABLE_KEY;
const DEFAULT_ALLOWED_LOGIN_IDENTIFIERS = ['mtgpros.com'];

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

// Domain validation component
function DomainValidator({ children, allowedLoginConfig }) {
  const { user, isLoaded } = useUser();

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
            <UserButton afterSignOutUrl="/" />
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
            <UserButton afterSignOutUrl="/" />
          </Box>
        </Paper>
      </Container>
    );
  }

  // User has valid allowlist match and verified email, render the app
  return children;
}

function Navigation({ darkMode, setDarkMode }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const isAdmin = user?.publicMetadata?.role === 'admin';

  const handleLogout = async () => {
    try {
      await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      console.error('Failed to record logout', e);
    } finally {
      await signOut({ redirectUrl: '/' });
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

function AppContent({ allowedLoginConfig }) {
  const [darkMode, setDarkMode] = useState(localStorage.getItem('darkMode') === 'true');

  React.useEffect(() => {
    localStorage.setItem('darkMode', darkMode);
  }, [darkMode]);

  const theme = createTheme({
    palette: { mode: darkMode ? "dark" : "light" },
  });

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <Router>
          <SignedIn>
            <DomainValidator allowedLoginConfig={allowedLoginConfig}>
              <Navigation darkMode={darkMode} setDarkMode={setDarkMode} />
              <Routes>
                <Route path="/" element={<FileViewer darkMode={darkMode} />} />
                <Route path="/admin" element={<AdminPage darkMode={darkMode} />} />
                <Route path="/reports" element={<ReportsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </DomainValidator>
          </SignedIn>
          
          <SignedOut>
            <Container maxWidth="sm" sx={{ mt: 8 }}>
              <Typography variant="h4" gutterBottom align="center">
                MTGPros Five9 Recordings
              </Typography>
              <Box sx={{ display: 'flex', justifyContent: 'center' }}>
                <SignIn routing="hash" />
              </Box>
            </Container>
          </SignedOut>
        </Router>
      </LocalizationProvider>
    </ThemeProvider>
  );
}

function ClerkConfigLoader() {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    if (CLERK_PUBLISHABLE_KEY) {
      setConfig({
        clerkPublishableKey: CLERK_PUBLISHABLE_KEY,
        allowedLoginConfig: ENV_ALLOWED_LOGIN_CONFIG
      });
      setLoading(false);
    }

    fetch('/api/config')
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;

        if (data.clerkPublishableKey) {
          const serverAllowedConfig = data.allowedLoginConfig
            ? normalizeAllowedLoginConfig(
                data.allowedLoginConfig,
                ENV_ALLOWED_LOGIN_CONFIG.entries.length ? ENV_ALLOWED_LOGIN_CONFIG.entries : DEFAULT_ALLOWED_LOGIN_IDENTIFIERS
              )
            : ENV_ALLOWED_LOGIN_CONFIG;

          setConfig({
            clerkPublishableKey: CLERK_PUBLISHABLE_KEY || data.clerkPublishableKey,
            allowedLoginConfig: serverAllowedConfig
          });

          if (!CLERK_PUBLISHABLE_KEY) {
            setLoading(false);
          }
        } else {
          if (!CLERK_PUBLISHABLE_KEY) {
            setError('Clerk publishable key not configured on server');
          }
        }
      })
      .catch(err => {
        if (cancelled) return;
        console.error('Failed to load config:', err);
        if (!CLERK_PUBLISHABLE_KEY) {
          setError('Failed to load configuration');
        }
      })
      .finally(() => {
        if (cancelled) return;
        if (!CLERK_PUBLISHABLE_KEY) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <Container maxWidth="sm" sx={{ mt: 8 }}>
        <Box sx={{ textAlign: 'center', p: 4 }}>
          <Typography variant="h6">Loading configuration...</Typography>
        </Box>
      </Container>
    );
  }

  if (error || !config?.clerkPublishableKey) {
    return (
      <Container maxWidth="sm" sx={{ mt: 8 }}>
        <Box sx={{ textAlign: 'center', p: 4, bgcolor: 'error.light', borderRadius: 2 }}>
          <Typography variant="h5" color="error" gutterBottom>
            ⚠️ Configuration Error
          </Typography>
          <Typography variant="body1" sx={{ mb: 2 }}>
            {error || 'Clerk publishable key is not configured.'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Please set CLERK_PUBLISHABLE_KEY in your server environment variables.
          </Typography>
          <Typography variant="caption" display="block" sx={{ mt: 2, fontFamily: 'monospace' }}>
            Expected format: pk_test_... or pk_live_...
          </Typography>
        </Box>
      </Container>
    );
  }

  return (
    <ClerkProvider publishableKey={config.clerkPublishableKey}>
      <AppContent allowedLoginConfig={config.allowedLoginConfig} />
    </ClerkProvider>
  );
}

function App() {
  return <ClerkConfigLoader />;
}

export default App;

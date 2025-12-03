import { clerkMiddleware, getAuth, clerkClient } from '@clerk/express';
import { logUserSession, logAuditEvent, getLastLogin, getUserSessions } from './database.js';

// Initialize Clerk with required environment variables
if (!process.env.CLERK_SECRET_KEY) {
  console.error('❌ CLERK_SECRET_KEY environment variable is required');
  process.exit(1);
}

if (!process.env.CLERK_PUBLISHABLE_KEY) {
  console.error('❌ CLERK_PUBLISHABLE_KEY environment variable is required');
  process.exit(1);
}

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

// Export the Clerk middleware for use in Express
export const clerkAuth = clerkMiddleware({
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  secretKey: process.env.CLERK_SECRET_KEY,
});

// Middleware to ensure user is authenticated and populate user data
export const requireAuth = async (req, res, next) => {
  try {
  const auth = getAuth(req);
    
    if (!auth?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Get full user details from Clerk
    const user = await clerkClient.users.getUser(auth.userId);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const primaryEmailAddress = user.emailAddresses?.find(email => email.id === user.primaryEmailAddressId);
    const userEmail = primaryEmailAddress?.emailAddress;
    const isEmailVerified = primaryEmailAddress?.verification?.status === 'verified';

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
    
    console.log(`✅ [AUTH ACCESS] User ${userEmail} granted access (allowlist match, verified)`);

    // Get client IP and user agent for audit logging
    const ipAddress = req.realClientIP || req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    console.log(`🔐 [AUTH] Client IP: ${ipAddress}, User Agent: ${userAgent.substring(0, 50)}...`);
    
    // Attempt to parse custom __session cookie claims (unverified decode, rely on clerk middleware for auth)
    let sessionClaims = null;
    try {
      const cookieHeader = req.headers['cookie'] || req.headers['Cookie'];
      if (cookieHeader) {
        const match = cookieHeader.split(';').map(s => s.trim()).find(c => c.startsWith('__session='));
        if (match) {
          const token = match.substring('__session='.length + match.indexOf('__session='));
          const raw = match.split('=')[1];
          const parts = raw.split('.');
            if (parts.length >= 2) {
              const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'));
              sessionClaims = payload;
            }
        }
      }
    } catch (e) {
      console.warn('Failed to decode __session claims:', e.message);
    }

    // Determine if there is an existing open session (logout_time NULL); if not, create one & log LOGIN
    let openSessionExists = false;
    try {
      const recent = getUserSessions(user.id, null, null, 5, 0);
      openSessionExists = recent.some(s => !s.logout_time);
    } catch (e) {
      console.warn('Could not determine open session state, proceeding to create new session:', e.message);
    }
    if (!openSessionExists) {
      const now = new Date();
      const lastLogin = getLastLogin(user.id);
      logUserSession(user.id, userEmail, ipAddress, userAgent);
      logAuditEvent(user.id, userEmail, 'LOGIN', null, null, ipAddress, userAgent, null, {
        lastLogin,
        loginTime: now.toISOString(),
        reason: 'new_session_no_open_session',
        claims: sessionClaims ? {
          email: sessionClaims.email,
            userId: sessionClaims.userId,
            firstName: sessionClaims.firstName,
            lastName: sessionClaims.lastName,
            lastSignedin: sessionClaims.lastSignedin
        } : null
      });
    }

    // Add user info to request for easier access (include Clerk sessionId for potential revocation)
    req.user = {
      id: user.id,
      email: userEmail,
      role: user.publicMetadata?.role || null,
      firstName: user.firstName,
      lastName: user.lastName,
      ipAddress: ipAddress,  // Real client IP (from realClientIP)
      userAgent: userAgent,
      sessionClaims
    };
    req.clerkSessionId = auth.sessionId || null;
    
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
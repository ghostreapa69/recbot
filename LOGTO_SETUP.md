# 🔐 Logto Authentication Setup Guide

This guide walks through configuring [Logto](https://logto.io/) authentication for RecBot, with role-based access control (admin / manager / member) and a domain allowlist.

> Migrated from Clerk. Existing audit/session logs are automatically relinked from old Clerk user IDs to Logto user IDs the first time each user signs in — see [Migration: relinking old logs](#-migration-relinking-old-logs).

## 📋 Prerequisites

1. A Logto instance — [Logto Cloud](https://cloud.logto.io/) or a self-hosted deployment.
2. Your RecBot application running behind a known domain (e.g. `https://recordings.yourcompany.com`).

## 🚀 Step 1: Create the SPA application

1. In the Logto Console go to **Applications → Create application**.
2. Choose **Single Page App** (framework: React).
3. Note the **App ID** and the tenant **endpoint** (e.g. `https://your-tenant.logto.app`).
4. Under the application's **Settings**, configure:
   - **Redirect URIs**:
     - `https://<your-domain>/callback`
     - `http://localhost:3000/callback` (for local dev)
   - **Post sign-out redirect URIs**:
     - `https://<your-domain>/`
     - `http://localhost:3000/`
   - **CORS allowed origins**: your app origin(s), e.g. `https://<your-domain>` and `http://localhost:3000`.

The frontend fetches `endpoint` / `appId` / `apiResource` at runtime from the backend's `/api/config`, so you do **not** need to rebuild the image to change them — set them as backend env vars (Step 4).

## 🔑 Step 2: Create the API resource

The backend validates access tokens against an API resource (audience).

1. Go to **API resources → Create API resource**.
2. Set the **API identifier** (indicator), e.g. `https://recbot.api`. This does not need to be a reachable URL.
3. Add **permissions (scopes)** to this resource:
   - `recbot:admin`
   - `recbot:manage`
   - `recbot:read`

This identifier becomes `LOGTO_API_RESOURCE`.

## 👥 Step 3: Configure roles (RBAC)

1. Go to **Roles → Create role** and create three roles: `admin`, `manager`, `member`.
2. Assign the API-resource permissions to each role:

   | Role | Permission scope |
   |------|------------------|
   | `admin` | `recbot:admin` |
   | `manager` | `recbot:manage` |
   | `member` | `recbot:read` |

3. **Assign roles to users** (Users → select user → Roles). Do this for each person as they self-register and first sign in. A user with no role is treated as having no elevated access.

> **Role names → app roles.** The backend maps the access token's permission `scope` to a role (`recbot:admin` → `admin`, etc.). The frontend reads role *names* from the userinfo `roles` claim — so make sure the **Roles** user scope is enabled (Step 5) so `admin`/`manager`/`member` reach the browser.

### Role definitions

- **`admin`**: full access — all files, admin dashboard, database management, reports export.
- **`manager`**: can download/stream recordings.
- **`member`** (or no role): view/stream within allowlist rules.

## 🔧 Step 4: Configure environment variables

Set these on the **backend** (in `docker-compose.yml` or your `.env`):

```bash
# --- Logto Authentication ---
LOGTO_ENDPOINT=https://your-tenant.logto.app
LOGTO_APP_ID=your-logto-spa-app-id
LOGTO_API_RESOURCE=https://recbot.api

# Optional: override the scope→role mapping (defaults shown)
# LOGTO_SCOPE_ADMIN=recbot:admin
# LOGTO_SCOPE_MANAGER=recbot:manage
# LOGTO_SCOPE_MEMBER=recbot:read

# Email/domain allowlist (comma-separated domains or exact addresses)
ALLOWED_LOGIN_IDENTIFIERS=yourcompany.com
REACT_APP_ALLOWED_LOGIN_IDENTIFIERS=yourcompany.com
```

The `docker-compose.yml` in this repo already contains this block — fill in real values.

## 🔒 Step 5: Sign-in experience & scopes

In the Logto Console:

1. **Sign-in experience → Sign-up and sign-in**: configure email and/or social connectors as desired. Restrict sign-up to your company domain to mirror `ALLOWED_LOGIN_IDENTIFIERS`.
2. Ensure the **Email** and **Roles** user scopes are available so the userinfo endpoint returns `email`, `email_verified`, and `roles`. (RecBot's frontend requests `email`, `profile`, and `roles`.)

## 🚀 Step 6: Deploy and test

1. Rebuild and push the RecBot image with the Logto integration, and point `docker-compose.yml`'s `image:` at the new tag.
2. Update your deployment with the Step 4 environment variables.
3. Visit the app — you should see the RecBot **Sign in** button → Logto sign-in → redirect back to `/callback` → the app.
4. Assign your account the `admin` role in Logto, sign in again, and confirm `/admin` is reachable.

## 🎯 Expected behavior

| User | Behavior |
|------|----------|
| **Admin** | All files, admin dashboard (`/admin`), DB sync, stats, exports |
| **Manager** | Can download/stream recordings |
| **Member / no role** | View & stream within allowlist rules; no admin dashboard |
| **Not on allowlist** | Access denied screen (even if authenticated in Logto) |
| **Unverified email** | Verification-required screen |
| **Unauthenticated** | Sign-in screen |

## 🔄 Migration: relinking old logs

Historical `user_sessions` and `audit_logs` rows were keyed by Clerk user IDs (`user_xxx`). Every row also stores `user_email`, which is the bridge to Logto.

- On each authenticated request, `linkLogtoIdentity()` (in `backend/database.js`) runs. The **first** time a given email is seen under a Logto user ID, it rewrites that user's historical log rows from the old Clerk ID to the Logto ID and records the mapping in the `user_identity_map` table. It is idempotent and short-circuits cheaply afterward.
- Users who have not signed in via Logto yet keep their old Clerk ID on historical rows but remain attributable by email. They are relinked automatically on first Logto login.

No manual data migration is required for the common case.

## 🐛 Troubleshooting

1. **Backend exits on startup with `LOGTO_ENDPOINT environment variable is required`**
   - Set `LOGTO_ENDPOINT` and `LOGTO_API_RESOURCE` in the backend environment.

2. **Sign-in redirect fails / "redirect_uri mismatch"**
   - The redirect URI registered in Logto must exactly match `https://<domain>/callback` (and `http://localhost:3000/callback` for dev).

3. **401 on API calls after signing in**
   - Confirm `LOGTO_API_RESOURCE` matches the API resource identifier in Logto, and that the SPA app requests that resource (it does via `/api/config`).

4. **Admin features missing for an admin user**
   - Ensure the user is assigned the `admin` role in Logto, the role carries `recbot:admin`, and the **Roles** user scope is enabled so role names reach the frontend.

5. **CORS errors**
   - Add your origin(s) to the SPA application's allowed origins in Logto.

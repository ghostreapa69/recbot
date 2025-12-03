# 🔐 Clerk Authentication Setup Guide

This guide will help you set up Clerk authentication for your RecBot application with role-based access control.

## 📋 Prerequisites

1. A Clerk account (free tier available)
2. Your RecBot application running

## 🚀 Step 1: Create Clerk Application

1. **Go to [Clerk Dashboard](https://dashboard.clerk.com/)**
2. **Click "Add application"**
3. **Configure your application:**
   - **Name:** RecBot Audio Manager
   - **Sign-in options:** Email, Google, Microsoft (choose what you prefer)
   - **Environment:** Development (for testing)

## 🔑 Step 2: Get API Keys

1. **In your Clerk Dashboard, go to "API Keys"**
2. **Copy the following keys:**
   - **Publishable key** (starts with `pk_test_` or `pk_live_`)
   - **Secret key** (starts with `sk_test_` or `sk_live_`)

## 🔧 Step 3: Configure Environment Variables

1. **Create a `.env` file in your RecBot root directory:**
```bash
# Frontend Clerk Configuration
REACT_APP_CLERK_PUBLISHABLE_KEY=pk_test_your_actual_key_here

# Backend Clerk Configuration  
CLERK_SECRET_KEY=sk_test_your_actual_secret_key_here
ALLOWED_LOGIN_IDENTIFIERS=yourcompany.com,admin@partner.com

# Frontend allowlist fallback (optional if backend provides runtime config)
REACT_APP_ALLOWED_LOGIN_IDENTIFIERS=yourcompany.com,admin@partner.com

# Your existing AWS and other configs...
STORAGE_TYPE=aws
AWS_ACCESS_KEY_ID=your-aws-access-key-id-here
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key-here
AWS_REGION=your-aws-region-here
AWS_BUCKET=your-aws-bucket-name-here
```

2. **Add the environment variables to your docker-compose.yml:**
```yaml
services:
  recbot:
    image: ghostreaper69/recbot:latest
    environment:
      - REACT_APP_CLERK_PUBLISHABLE_KEY=pk_test_your_key_here
      - CLERK_SECRET_KEY=sk_test_your_secret_key_here
      # ... your existing environment variables
```

## 👥 Step 4: Configure User Roles

### In Clerk Dashboard:

1. **Go to "Users" section**
2. **Click on a user to edit**
3. **Go to "Metadata" tab**
4. **Add to "Public metadata":**
```json
{
  "role": "admin"
}
```
**OR**
```json
{
  "role": "member"
}
```

### Role Definitions:

- **`admin`**: Can access all files, admin dashboard, database management
- **`member`**: Can only view files associated with their email address

## 🔒 Step 5: Configure Authentication Settings

### In Clerk Dashboard → Settings:

1. **Sessions:**
   - Set session lifetime as needed (default 7 days is fine)

2. **Restrictions:**
   - Enable "Restricted to allowlist" if you want to control who can sign up
   - Add email addresses or domains to the allowlist

3. **Social Connections (Optional):**
   - Configure Google, Microsoft, etc. if desired

## 🌐 Step 6: Configure Allowed Origins

1. **In Clerk Dashboard → "API Keys"**
2. **Add your domains to "Allowed origins":**
   - `http://localhost:3000` (development)
   - `https://your-domain.com` (production)

## 🚀 Step 7: Deploy and Test

1. **Rebuild your Docker image with Clerk integration:**
```bash
docker build -t ghostreaper69/recbot:latest .
docker push ghostreaper69/recbot:latest
```

2. **Update your deployment with new environment variables**

3. **Test the authentication:**
   - Visit your RecBot application
   - You should see a Clerk sign-in page
   - Sign up/sign in with your test account
   - Assign the `admin` role to your account in Clerk Dashboard
   - Access the admin dashboard at `/admin`

## 🎯 Expected Behavior

### For Admin Users:
- ✅ Can access all audio files
- ✅ Can use admin dashboard (`/admin` route)
- ✅ Can sync database
- ✅ Can view database statistics

### For Member Users:
- ✅ Can only see files containing their email address
- ❌ Cannot access admin dashboard
- ❌ Cannot sync database
- ✅ Clean, filtered interface

### For Unauthenticated Users:
- ❌ Cannot access any files
- ❌ Redirected to sign-in page

## 🐛 Troubleshooting

### Common Issues:

1. **"Invalid publishable key" error:**
   - Check that your `REACT_APP_CLERK_PUBLISHABLE_KEY` is correct
   - Ensure it starts with `pk_test_` or `pk_live_`

2. **"User not found" or token errors:**
   - Verify your `CLERK_SECRET_KEY` in backend environment
   - Make sure secret key matches your Clerk application

3. **Role-based access not working:**
   - Check user metadata in Clerk Dashboard
   - Ensure role is set in "Public metadata" (not Private)
   - Role must be exactly `"admin"` or `"member"`

4. **CORS errors:**
   - Add your domain to Clerk's allowed origins
   - Check that frontend and backend URLs match

## 🔄 Next Steps

1. **Production Setup:**
   - Switch to production Clerk keys for live deployment
   - Configure proper domain restrictions
   - Set up user provisioning workflow

2. **Enhanced Security:**
   - Enable MFA in Clerk for admin users
   - Set up webhook for user role changes
   - Configure session management policies

3. **User Management:**
   - Create admin interface for role assignment
   - Set up email templates for user onboarding
   - Configure user deletion/suspension workflows

## 📞 Support

If you encounter issues:
1. Check Clerk Dashboard logs
2. Review browser console for frontend errors  
3. Check backend logs for authentication failures
4. Verify environment variables are properly set

Your RecBot application now has enterprise-grade authentication with role-based access control! 🎉
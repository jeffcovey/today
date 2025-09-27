# Secure Web Access Documentation

## Overview

The Today application uses encrypted credentials stored with dotenvx for secure authentication. This document explains how to access the deployed application securely without exposing passwords in plain text.

## Authentication Architecture

### 1. Credential Storage

- Credentials are stored encrypted in `.env` using dotenvx
- Decryption key is in `.env.keys` (NEVER commit this file)
- Web server reads credentials from environment variables: `WEB_USER` and `WEB_PASSWORD`

### 2. Session-Based Authentication

- The web server uses Express sessions with SQLite storage
- Sessions persist for 7 days by default
- Cookies are marked secure in production (HTTPS only)

## Accessing the Deployed Application

### Method 1: Browser Access (Recommended)

1. Navigate to https://today.jeffcovey.net
2. Enter credentials at login prompt
3. Session persists for 7 days

### Method 2: Retrieve Encrypted Credentials Locally

```bash
# Decrypt credentials locally (requires .env.keys)
npx dotenvx get WEB_USER
npx dotenvx get WEB_PASSWORD

# Or get both at once
npx dotenvx get WEB_USER WEB_PASSWORD --format shell
```

### Method 3: Programmatic Access with curl

```bash
# First, decrypt password locally
PASSWORD=$(npx dotenvx get WEB_PASSWORD --format shell)

# Login and save session cookie
curl -c cookies.txt -X POST \
  -d "username=admin" \
  --data-urlencode "password=$PASSWORD" \
  https://today.jeffcovey.net/auth/login

# Access protected resources
curl -b cookies.txt https://today.jeffcovey.net/tasks-today.md
```

### Method 4: Using deploy-do fetch (Recommended for CLI)

```bash
# Fetch pages with automatic authentication
bin/deploy-do fetch /                        # Homepage
bin/deploy-do fetch /tasks-today.md          # Today's tasks
bin/deploy-do fetch /plans/                  # Plans directory

# Options:
bin/deploy-do fetch /tasks-today.md --raw    # Get raw HTML
bin/deploy-do fetch /tasks-today.md --output tasks.html  # Save to file
bin/deploy-do fetch /api/health --no-auth    # Skip auth for public endpoints
bin/deploy-do fetch /tasks-today.md --headers  # Include HTTP headers
```

### Method 5: Manual Remote Access via deploy-do exec

```bash
# Execute commands on droplet with authentication
PASSWORD=$(npx dotenvx get WEB_PASSWORD --format shell)

bin/deploy-do exec "curl -X POST -d 'username=admin' \
  --data-urlencode 'password=$PASSWORD' \
  https://today.jeffcovey.net/auth/login \
  -c /tmp/auth-cookies.txt"

# Then use the cookie for authenticated requests
bin/deploy-do exec "curl -b /tmp/auth-cookies.txt \
  https://today.jeffcovey.net/tasks-today.md"
```

## Security Best Practices

### 1. Credential Management

- **NEVER** commit `.env.keys` to version control
- Keep `.env.keys` in a secure password manager
- Rotate passwords periodically using `npx dotenvx set`

### 2. Updating Credentials

```bash
# Change password securely
npx dotenvx set WEB_PASSWORD "new-secure-password"

# Deploy new encrypted credentials
bin/deploy-do secrets

# Restart web server to apply
bin/deploy-do web-restart
```

### 3. Environment-Specific Security

- Production uses HTTPS-only secure cookies
- Sessions stored in SQLite database (`.data/sessions.db`)
- Session secret auto-generated if not specified

## Testing Authentication

### Local Testing

```bash
# Start local server
npm run dev

# Test with decrypted credentials
USER=$(npx dotenvx get WEB_USER)
PASS=$(npx dotenvx get WEB_PASSWORD)
curl -u "$USER:$PASS" http://localhost:3000/
```

### Remote Testing

```bash
# Check authentication is working
bin/deploy-do exec "curl -I https://today.jeffcovey.net"
# Should redirect to /auth/login

# Test with credentials
PASSWORD=$(npx dotenvx get WEB_PASSWORD)
bin/deploy-do exec "curl -X POST \
  -d 'username=admin' \
  --data-urlencode 'password=$PASSWORD' \
  https://today.jeffcovey.net/auth/login \
  -w '\n%{http_code}\n'"
# Should return 302 (redirect on success)
```

## Troubleshooting

### Cannot Decrypt Credentials

1. Ensure `.env.keys` exists and contains `DOTENV_PRIVATE_KEY`
2. Verify dotenvx is installed: `npm install -g @dotenvx/dotenvx`
3. Check `.env` contains encrypted values starting with `"encrypted:B..."`

### Session Not Persisting

1. Check cookies are enabled in browser
2. Verify HTTPS is working (production requires secure cookies)
3. Check session database: `bin/deploy-do exec "ls -la .data/sessions.db"`

### Forgotten Password

1. Generate new password locally:

   ```bash
   # Generate secure password
   openssl rand -base64 32

   # Set it with dotenvx
   npx dotenvx set WEB_PASSWORD "new-password-here"

   # Deploy to server
   bin/deploy-do secrets
   bin/deploy-do web-restart
   ```

## API Endpoint Authentication

The web server exposes these authentication endpoints:

- `GET /auth/login` - Login form
- `POST /auth/login` - Submit credentials (form data: username, password)
- `GET /auth/logout` - Destroy session

All other routes require authentication and redirect to `/auth/login` if not authenticated.

## Important Files

- `.env` - Encrypted credentials (safe to commit)
- `.env.keys` - Decryption key (NEVER commit)
- `src/web-server.js` - Authentication implementation (lines 93-143)
- `.data/sessions.db` - Session storage on server
- `bin/deploy-do` - Deployment script with secrets management

## Security Notes

1. The password shown in the conversation history should be rotated if it's still in use
2. Always use HTTPS in production to protect session cookies
3. Consider implementing rate limiting for login attempts
4. Monitor authentication logs: `bin/deploy-do exec "journalctl -u vault-web | grep auth"`

# Vault Web Server Deployment Guide

## Overview

The vault web server provides secure, authenticated web access to your vault files with directory browsing and markdown rendering.

## Components

### 1. Web Server (`src/web-server.js`)

- Express 4.x server with basic authentication
- Directory browsing with clickable navigation
- Markdown file rendering with GitHub-style CSS
- Runs on port 3001 (configurable via WEB_PORT)

### 2. Systemd Service (`config/vault-web.service`)

- Auto-starts on boot
- Restarts on failure
- Runs with dotenvx for encrypted environment variables

### 3. Nginx Configuration (`config/nginx-vault.conf`)

- Reverse proxy to Node.js server
- SSL/HTTPS support via Let's Encrypt
- Security headers and rate limiting

### 4. Setup Script (`bin/setup-vault-web`)

- Automated deployment to DigitalOcean droplet
- Installs dependencies (nginx, certbot)
- Generates secure credentials
- Configures SSL certificate

## Prerequisites

1. **Domain Name Required**
   - You need a domain or subdomain pointing to your droplet IP (45.55.122.152)
   - SSL certificates require a valid domain name
   - Cannot use raw IP addresses with Let's Encrypt

2. **DNS Setup**
   - Add an A record pointing your domain to 45.55.122.152
   - Example: `vault.yourdomain.com` → `45.55.122.152`
   - Wait for DNS propagation (5-30 minutes typically)

## Deployment Steps

### 1. Set Up Domain

```bash
# Add DNS A record at your domain registrar:
Type: A
Name: vault (or @ for root domain)
Value: 45.55.122.152
TTL: 3600 (or default)
```

### 2. Deploy to Droplet

```bash
# SSH into your droplet
ssh root@45.55.122.152

# Navigate to project
cd /opt/today

# Pull latest changes
git pull

# Run setup script with your domain
./bin/setup-vault-web vault.yourdomain.com
```

### 3. What the Setup Script Does

1. Installs nginx and certbot if needed
2. Generates random password for web interface
3. Adds credentials to encrypted .env file
4. Creates systemd service for auto-start
5. Configures nginx reverse proxy
6. Obtains SSL certificate from Let's Encrypt
7. Starts the web server

### 4. Access Your Vault

- URL: `https://vault.yourdomain.com`
- Username: `admin`
- Password: (shown during setup, saved encrypted in .env)

## Managing the Service

### Check Status

```bash
systemctl status vault-web
```

### View Logs

```bash
journalctl -u vault-web -f
```

### Restart Service

```bash
systemctl restart vault-web
```

### View Credentials

```bash
cd /opt/today
npx dotenvx run -- bash -c 'echo Username: $WEB_USER; echo Password: $WEB_PASSWORD'
```

## Security Features

1. **HTTPS Only** - Automatic redirect from HTTP to HTTPS
2. **Basic Authentication** - Username/password required
3. **Encrypted Credentials** - Password stored encrypted with dotenvx
4. **Security Headers** - X-Frame-Options, X-Content-Type-Options, etc.
5. **Rate Limiting** - Nginx-level protection against brute force

## Alternative: HTTP-Only Setup (Not Recommended)

If you don't have a domain yet, you can temporarily use HTTP with IP access:

```bash
# Manual setup without SSL
cd /opt/today

# Add credentials to .env
echo "WEB_USER=admin" >> .env
echo "WEB_PASSWORD=$(openssl rand -base64 32)" >> .env
echo "WEB_PORT=3001" >> .env
npx dotenvx encrypt

# Install and start service
sudo cp config/vault-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable vault-web
sudo systemctl start vault-web

# Access at http://45.55.122.152:3001
# (Note: passwords sent in clear text without HTTPS!)
```

## Domain Options

### Free Domain Services

1. **DuckDNS** (duckdns.org) - Free subdomains like `yourvault.duckdns.org`
2. **Freenom** (freenom.com) - Free .tk, .ml, .ga domains
3. **No-IP** (noip.com) - Free dynamic DNS service

### Using a Subdomain

If you already own a domain, create a subdomain:
- `vault.yourdomain.com`
- `notes.yourdomain.com`
- `today.yourdomain.com`

## Troubleshooting

### SSL Certificate Issues

- Ensure domain points to correct IP
- Check DNS propagation: `nslookup vault.yourdomain.com`
- Verify port 80 and 443 are open in firewall

### Service Won't Start

- Check logs: `journalctl -u vault-web -n 50`
- Verify .env file exists and is encrypted
- Check Node.js version: `node --version` (needs v20+)

### Authentication Not Working

- Verify credentials in .env
- Check nginx is passing auth headers
- Test locally first: `curl -u admin:password http://localhost:3001`

### Testing and Accessing the Web Server

#### From Development Environment (Codespace/Local)

```bash
# The correct way to access the deployed web server with authentication:
# Note: Use the domain name, NOT the IP address directly

# Option 1: Test from the deployed server itself (most reliable)
bin/deploy-do exec "cd /opt/today && npx dotenvx run -- bash -c 'curl -s -u admin:\$WEB_PASSWORD http://localhost:3001/daily'"

# Option 2: Direct access with credentials (if you know them)
curl -u 'admin:5RDx9/RcQD2K/iXbKhhFyvn97ZSHW5uKUAMbfZbzV9g=' http://today.oldergay.men/daily

# Option 3: Using environment variables locally
npx dotenvx run -- bash -c 'curl -u "$WEB_USER:$WEB_PASSWORD" http://today.oldergay.men/daily'

# To check specific elements in the HTML:
bin/deploy-do exec "cd /opt/today && npx dotenvx run -- bash -c 'curl -s -u admin:\$WEB_PASSWORD http://localhost:3001/daily | grep chatMessages'"
```

#### Important Notes

- The web server runs on port 3001 on the server
- It's proxied through nginx to the domain
- Always use the domain name (today.oldergay.men) not the raw IP
- SSL issues may occur with Cloudflare (error 525) - use HTTP or test locally on server
- The server requires Basic Auth with credentials from .env

## File Structure

```
/opt/today/
├── src/
│   └── web-server.js       # Express server
├── config/
│   ├── vault-web.service   # Systemd service
│   └── nginx-vault.conf    # Nginx template
├── bin/
│   └── setup-vault-web     # Setup script
├── vault/                  # Files served by web server
│   ├── projects/
│   ├── plans/
│   ├── topics/
│   ├── notes/
│   └── templates/
└── .env                    # Encrypted credentials
```

## Notes

- The web server only provides read-only access to vault files
- Files are rendered as HTML for .md files, plain text for others
- Directory listings show files and folders with icons
- Templates directory is included in browsing (unlike task processing)

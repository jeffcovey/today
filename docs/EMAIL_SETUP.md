# Email CLI Setup Guide

## Overview

The email tool allows you to download and manage emails from your iCloud account locally.

## Setup Instructions

### 1. Generate App-Specific Password for iCloud

Since you're using jeff.covey@icloud.com, you'll need to create an app-specific password:

1. Go to https://appleid.apple.com
2. Sign in with your Apple ID
3. Navigate to "Sign-In and Security"
4. Click on "App-Specific Passwords"
5. Click the "+" button to generate a new password
6. Name it something like "today-cli-email"
7. Copy the generated password (format: xxxx-xxxx-xxxx-xxxx)

### 2. Configure Environment Variables

Add the following to your `.env` file:

```
EMAIL_ACCOUNT=jeff.covey@icloud.com
EMAIL_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

Replace `xxxx-xxxx-xxxx-xxxx` with your actual app-specific password.

### 3. Install the CLI

If you haven't already, run:

```bash
npm install
npm link  # This makes email available globally
```

## Usage

### Download Emails

Download last 30 days (default):

```bash
email download
```

Download last 7 days:

```bash
email download --days 7
```

Download from a specific account:

```bash
email download --account another@icloud.com
```

### View Setup Instructions

```bash
email setup
```

## Database Storage

Emails are stored in the SQLite database at `.data/today.db` in the `emails` table with the following structure:

- `uid`: Unique identifier from IMAP
- `message_id`: Email message ID
- `from_address`: Sender email
- `to_address`: Recipient email
- `subject`: Email subject
- `date`: Email date
- `text_content`: Plain text content
- `html_content`: HTML content
- `attachments`: JSON array of attachment metadata
- `flags`: Email flags (read, starred, etc.)
- `size`: Email size in bytes
- `raw_source`: Base64 encoded raw email

## Troubleshooting

### Authentication Failed

- Ensure you're using an app-specific password, not your regular Apple ID password
- Check that the password is entered correctly in the .env file
- Make sure 2-factor authentication is enabled on your Apple ID

### Connection Issues

- iCloud IMAP server: imap.mail.me.com
- Port: 993 (SSL/TLS)
- Requires secure connection

### Rate Limiting

- Apple may rate limit IMAP connections
- If you get errors, wait a few minutes and try again
- Consider downloading in smaller batches using the --days option

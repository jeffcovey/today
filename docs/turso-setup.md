# Turso Database Setup

This project uses Turso for database synchronization across multiple deployments. Turso provides a distributed SQLite-compatible database that syncs automatically.

## Why Turso?

- **Multi-deployment sync**: All environments share the same database
- **SQLite compatible**: Minimal code changes required
- **Edge replicas**: Fast local reads with automatic sync
- **Offline support**: Works without internet, syncs when connected
- **Free tier**: 8GB storage, 9 locations, 500 databases

## Initial Setup (One Time)

1. **Authenticate with Turso:**

   ```bash
   bin/migrate-to-turso auth
   ```

   This opens a browser for signup/login.

2. **Create database:**

   ```bash
   bin/migrate-to-turso create today-db
   ```

   This will:
   - Create a Turso database
   - Generate credentials
   - Append them to `.env`
   - Encrypt them with dotenvx

3. **Push existing data:**

   ```bash
   bin/migrate-to-turso push
   ```

   This migrates your local SQLite database to Turso.

4. **Test connection:**

   ```bash
   bin/migrate-to-turso test
   ```

5. **Commit the updated encrypted env:**

   ```bash
   git add .env
   git commit -m "Add Turso database credentials (encrypted)"
   git push
   ```

## Setting Up Other Deployments

On each new deployment, you only need the `.env.keys` file:

1. **Copy `.env.keys`** from your main environment
2. **Run commands with dotenvx:**

   ```bash
   npx dotenvx run -- bin/sync
   npx dotenvx run -- bin/tasks
   ```

Or set up an alias:

```bash
alias today="npx dotenvx run -- bin/today"
```

## Docker Deployments

The Dockerfiles are already configured with Turso CLI. Just ensure:

1. `.env.keys` is present
2. `.env` with encrypted values is in the repository
3. Use dotenvx to run commands:

   ```bash
   docker run -v $(pwd)/.env.keys:/app/.env.keys \
              myimage \
              npx dotenvx run -- node src/cli.js
   ```

## Fallback to Local SQLite

If Turso credentials are not available (missing `.env.keys` or encrypted `.env`), the system automatically falls back to local SQLite in `.data/today.db`.

## Security Notes

- **NEVER commit `.env.keys`** - Contains decryption keys
- **DO commit `.env`** - Contains encrypted credentials (safe when encrypted with dotenvx)
- **DO share `.env.keys`** securely between deployments

## Troubleshooting

### "TURSO_DATABASE_URL not found"

- Ensure `.env.keys` is present
- Ensure `.env` with encrypted values is committed
- Run with `npx dotenvx run --`

### "Database not syncing"

- Check internet connection
- Verify credentials: `bin/migrate-to-turso test`
- Check Turso dashboard: https://turso.tech

### "Permission denied"

- Make scripts executable: `chmod +x bin/*`

## Costs

The free tier includes:
- 8GB total storage
- 1 billion row reads/month
- 25 million row writes/month

This should be more than sufficient for personal use. Monitor usage at https://turso.tech/dashboard.

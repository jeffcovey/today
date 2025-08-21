# Deploy Scheduler to Fly.io

Fly.io provides a generous free tier that includes:
- 3 shared VMs (more than enough for a scheduler)
- 3GB persistent storage
- 160GB outbound transfer

## Quick Deploy

We have an automated deployment script that handles everything:

```bash
# First time deployment (setup + secrets + deploy)
bin/deploy-scheduler full

# Future deployments (after code changes)
bin/deploy-scheduler deploy
```

The script automatically:
- Installs Fly CLI if needed
- Creates the app and volumes
- Loads secrets from your .env file using dotenvx
- Deploys the scheduler

## Manual Setup (if you prefer)

1. **Install Fly CLI** (already in dev container):
```bash
curl -L https://fly.io/install.sh | sh
```

2. **Sign up and login**:
```bash
fly auth signup  # or fly auth login if you have an account
```

3. **Deploy using our script**:
```bash
bin/deploy-scheduler full
```

## Daily Operations

**Check logs**:
```bash
fly logs
```

**Deploy updates** (after changing code):
```bash
fly deploy
```

**Check status**:
```bash
fly status
```

**SSH into container** (for debugging):
```bash
fly ssh console
```

## Schedule Customization

Edit `src/scheduler.js` to change the schedule. The current schedule:
- Every 10 min: `bin/sync --quick`
- Every 2 hours (5AM-9PM): `bin/today "Update today's review file"`
- Daily at 4AM: `bin/sync` (full sync)
- Every 4 hours: `bin/sync --quick-email`

After changes, deploy with `fly deploy`.

## Cost

Should be **free** unless you:
- Need more than 3GB storage
- Use excessive bandwidth (>160GB/month)
- Want dedicated VMs instead of shared

Monitor usage at: https://fly.io/dashboard
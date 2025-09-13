# OlderGay.Men Monitoring Integration

This integration brings OlderGay.Men service monitoring data into your daily planning workflow, allowing `bin/today` to consider GitHub issues, error reports, and performance metrics when suggesting what to work on.

## Setup

### 1. Configure API Tokens

Add the following to your `.env` file:

```bash
# GitHub (required for issue tracking)
GITHUB_ACCESS_TOKEN=your_github_personal_access_token

# Sentry (optional - for error tracking)
SENTRY_AUTH_TOKEN=your_sentry_auth_token
SENTRY_ORG=your_organization_slug  # default: oldergay-men
SENTRY_PROJECT=your_project_slug    # default: rails

# Scout APM (optional - for performance metrics)
SCOUT_API_KEY=your_scout_api_key
SCOUT_APP_ID=76830  # OlderGay.Men app ID
```

#### Getting the tokens

- **GitHub**: Create a personal access token at https://github.com/settings/tokens
  - Needs `repo` scope for private repositories
  
- **Sentry**: Get your auth token from https://sentry.io/settings/account/api/auth-tokens/
  - The token needs at least 'project:read' and 'event:read' scopes
  
- **Scout APM**: Get your API key from https://scoutapm.com/apps
  - Look for API keys in account settings

### 2. Test Individual Components

```bash
# Test GitHub issues sync
bin/ogm-sync issues

# Test Sentry errors sync
bin/ogm-sync errors

# Test Scout performance sync
bin/ogm-sync performance

# View summary statistics
bin/ogm-sync summary
```

### 3. Full Sync

The OGM monitoring sync is automatically included in the main sync process:

```bash
# Sync all data sources including OGM monitoring
bin/sync
```

Or run just the OGM sync:

```bash
# Sync all OGM monitoring data
bin/ogm-sync
```

## Data Available to bin/today

After syncing, the following data is available in the SQLite database for AI planning:

### Tables Created

1. **ogm_github_issues**: Open issues, recent activity, labels, comments
2. **ogm_sentry_issues**: Unresolved errors, frequency, last occurrence
3. **ogm_scout_metrics**: Response times, throughput, error rates
4. **ogm_correlations**: Links between GitHub issues and errors
5. **ogm_summary_stats**: Daily aggregated statistics

### How bin/today Uses This Data

When you run `bin/today`, Claude can now:

- Prioritize work based on open GitHub issues
- Identify critical errors that need immediate attention
- Consider performance problems when planning optimizations
- Correlate issues with errors for better debugging context
- Track trends over time to identify recurring problems

### Example Queries Claude Might Run

```sql
-- Get high-priority open issues
SELECT number, title, comments_count 
FROM ogm_github_issues 
WHERE state='open' 
ORDER BY updated_at DESC;

-- Find frequently occurring errors
SELECT title, culprit, count 
FROM ogm_sentry_issues 
WHERE status='unresolved' 
ORDER BY count DESC;

-- Check recent performance metrics
SELECT metric_type, value 
FROM ogm_scout_metrics 
WHERE DATE(timestamp) = DATE('now') 
ORDER BY timestamp DESC;
```

## Using the Ruby Scripts Directly

The original Ruby scripts in `tmp/` can still be used independently:

```bash
# GitHub issues
tmp/github-issues list open 50
tmp/github-issues get 4304
tmp/github-issues search "slow database"

# Sentry errors
bin/sentry list 20
bin/sentry show 121311876
bin/sentry events 121311876

# Scout performance
tmp/scout slow 24
tmp/scout errors
tmp/scout throughput
```

## Troubleshooting

### No data syncing?

- Check that API tokens are correctly set in `.env`
- Run `bin/ogm-sync` manually to see detailed error messages

### Database errors?

- The tables are created automatically on first run
- To reset: `sqlite3 .data/today.db "DROP TABLE ogm_github_issues;"`

### Sync taking too long?

- Limit the sync to recent data only
- Consider running individual syncs (issues, errors, performance) separately

## Integration with Daily Workflow

1. **Morning**: Run `bin/sync` to fetch all data including OGM monitoring
2. **Review**: Run `bin/today` - Claude will consider the monitoring data
3. **During day**: Mark issues resolved, add progress notes as usual
4. **End of day**: Review metrics to see impact of your work

The monitoring data helps Claude make better recommendations about:
- Which bugs to fix first (based on error frequency)
- Performance optimizations needed (based on Scout metrics)
- User-reported issues requiring attention (GitHub issues)
- Correlations between errors and issues

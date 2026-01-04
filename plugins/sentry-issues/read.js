#!/usr/bin/env node

// Read issues from Sentry using the Sentry API
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with entries array

const API_BASE = 'https://sentry.io/api/0';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const organization = config.organization;
const project = config.project || '';
const query = config.query || 'is:unresolved';
const limit = config.limit || 100;
const authToken = config.auth_token;  // Injected by plugin-loader from encrypted env var
const sourceId = process.env.SOURCE_ID || '';

if (!authToken) {
  console.error(JSON.stringify({
    error: 'Sentry auth token not configured. Use "bin/today configure" to set up credentials.'
  }));
  process.exit(1);
}

if (!organization) {
  console.error(JSON.stringify({
    error: 'organization setting is required'
  }));
  process.exit(1);
}

// Check for incremental sync
const lastSyncTime = process.env.LAST_SYNC_TIME || '';

async function fetchFromSentry(endpoint) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Sentry API error ${response.status}: ${text}`);
  }

  return response.json();
}

// Function to get total count from Sentry API
async function getSentryTotalCount() {
  try {
    let searchQuery = query;
    if (project) {
      searchQuery = `project:${project} ${query}`;
    }

    // Get total count without time filters
    const params = new URLSearchParams();
    params.set('query', searchQuery);
    params.set('limit', '1'); // We only need the total count
    params.set('sort', 'date');

    const endpoint = `/organizations/${organization}/issues/?${params.toString()}`;

    // Sentry doesn't return total count in headers like GitHub, so this is an estimate
    // We'll need to actually fetch to get a realistic count
    const data = await fetchFromSentry(endpoint);

    // Since Sentry doesn't provide total count easily, we'll use the actual fetched count
    // For better validation, we could fetch multiple pages, but this is a reasonable approximation
    return Array.isArray(data) ? Math.min(data.length * 10, 200) : 0; // Rough estimate
  } catch (error) {
    console.error(`Warning: Could not get total count from Sentry: ${error.message}`, { stderr: true });
    return null;
  }
}

// Function to get local count from database (if available)
function getLocalCount() {
  try {
    const projectRoot = process.env.PROJECT_ROOT || '';
    if (!projectRoot) return 0;

    const { execSync } = require('child_process');
    const countCmd = `sqlite3 "${projectRoot}/.data/today.db" "SELECT COUNT(*) FROM issues WHERE source = '${sourceId}'"`;
    const result = execSync(countCmd, { encoding: 'utf8' });
    return parseInt(result.trim()) || 0;
  } catch (error) {
    // Don't fail if we can't get local count - just assume 0
    return 0;
  }
}

async function fetchIssues() {
  const issues = [];

  // Build search query - include project filter in query string
  let searchQuery = query;
  if (project) {
    searchQuery = `project:${project} ${query}`;
  }

  // VALIDATION: Check if incremental sync is safe
  let forceFullSync = false;
  let useIncremental = false;

  if (lastSyncTime) {
    const sentryTotal = await getSentryTotalCount();
    const localCount = getLocalCount();

    if (sentryTotal !== null && localCount > 0) {
      // If local count is significantly less than estimated total, force full sync
      const threshold = Math.max(sentryTotal * 0.8, sentryTotal - 10);

      if (localCount < threshold) {
        console.error(`Auto-correcting sync: Local ${localCount}, Sentry ~${sentryTotal} - forcing full sync`, { stderr: true });
        forceFullSync = true;
      } else {
        // Incremental sync is safe
        useIncremental = true;
      }
    } else {
      // If we can't validate, default to incremental to be safe
      useIncremental = true;
    }
  }

  // Build query parameters
  const params = new URLSearchParams();
  params.set('query', searchQuery);
  params.set('limit', String(Math.min(limit, 100))); // Sentry max is 100
  params.set('sort', 'date');

  // Incremental sync - filter by date range (only if not forcing full sync)
  if (useIncremental && !forceFullSync) {
    const lastSync = new Date(lastSyncTime);
    lastSync.setDate(lastSync.getDate() - 1); // Go back one day to be safe
    params.set('start', lastSync.toISOString());
    params.set('end', new Date().toISOString());
  }

  let endpoint = `/organizations/${organization}/issues/?${params.toString()}`;
  let pageCount = 0;
  const maxPages = 10; // Safety limit

  while (endpoint && pageCount < maxPages && issues.length < limit) {
    const data = await fetchFromSentry(endpoint);

    if (Array.isArray(data)) {
      issues.push(...data);
    }

    // Sentry uses Link header for pagination, but for simplicity we'll just get first page
    // TODO: Parse Link header for cursor-based pagination if needed
    endpoint = null;
    pageCount++;
  }

  return {
    issues: issues.slice(0, limit),
    isIncremental: useIncremental && !forceFullSync,
    forcedFullSync: forceFullSync
  };
}

function transformIssue(issue) {
  // Build metadata object
  const metadata = {};

  if (issue.level) {
    metadata.level = issue.level;
  }

  if (issue.culprit) {
    metadata.culprit = issue.culprit;
  }

  if (issue.count) {
    metadata.count = issue.count;
  }

  if (issue.userCount) {
    metadata.userCount = issue.userCount;
  }

  if (issue.platform) {
    metadata.platform = issue.platform;
  }

  if (issue.lastSeen) {
    metadata.lastSeen = issue.lastSeen;
  }

  if (issue.project) {
    metadata.project = issue.project.slug || issue.project.name;
  }

  if (issue.shortId) {
    metadata.shortId = issue.shortId;
  }

  // Map Sentry status to open/closed
  // Sentry statuses: unresolved, resolved, ignored
  let state = 'open';
  if (issue.status === 'resolved' || issue.status === 'ignored') {
    state = 'closed';
  }

  // Use permalink if available, otherwise construct URL
  const url = issue.permalink || `https://sentry.io/organizations/${organization}/issues/${issue.id}/`;

  return {
    id: issue.id,
    title: issue.title || issue.metadata?.value || '(No title)',
    state,
    opened_at: issue.firstSeen || new Date().toISOString(),
    url,
    body: issue.culprit ? `${issue.culprit}\n\nLevel: ${issue.level || 'unknown'}\nEvents: ${issue.count || 0}\nUsers: ${issue.userCount || 0}` : null,
    metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
  };
}

// Main execution
try {
  const { issues, isIncremental, forcedFullSync } = await fetchIssues();
  const entries = issues.map(transformIssue);

  console.log(JSON.stringify({
    entries,
    total: entries.length,
    incremental: isIncremental,
    forced_full_sync: forcedFullSync,
    validation: {
      sentry_total_estimate: await getSentryTotalCount(),
      local_count: getLocalCount()
    }
  }));
} catch (error) {
  console.error(JSON.stringify({
    error: `Failed to fetch issues: ${error.message}`
  }));
  process.exit(1);
}
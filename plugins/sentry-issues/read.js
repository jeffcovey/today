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

async function fetchIssues() {
  const issues = [];

  // Build search query - include project filter in query string
  let searchQuery = query;
  if (project) {
    searchQuery = `project:${project} ${query}`;
  }

  // Build query parameters
  const params = new URLSearchParams();
  params.set('query', searchQuery);
  params.set('limit', String(Math.min(limit, 100))); // Sentry max is 100
  params.set('sort', 'date');

  // Incremental sync - filter by date range
  // Sentry requires both start and end when using date filters
  if (lastSyncTime) {
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

  return issues.slice(0, limit);
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
  const issues = await fetchIssues();
  const entries = issues.map(transformIssue);

  const isIncremental = !!lastSyncTime;

  console.log(JSON.stringify({
    entries,
    total: entries.length,
    incremental: isIncremental
  }));
} catch (error) {
  console.error(JSON.stringify({
    error: `Failed to fetch issues: ${error.message}`
  }));
  process.exit(1);
}

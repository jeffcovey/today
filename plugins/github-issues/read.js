#!/usr/bin/env node

// Read issues from GitHub using gh CLI
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with entries array
//
// Requires: gh CLI installed and authenticated

import { execSync } from 'child_process';

// Clear environment tokens so gh uses its own OAuth session from `gh auth login`
// Otherwise it would try to use potentially stale tokens from .env
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
delete process.env.GH_ENTERPRISE_TOKEN;

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const repository = config.repository;
const includeClosedConfig = config.include_closed;
const limit = config.limit || 100;

if (!repository) {
  console.error(JSON.stringify({
    error: 'repository setting is required (e.g., "owner/repo")'
  }));
  process.exit(1);
}

// Check if gh CLI is available
try {
  execSync('gh --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
} catch (error) {
  console.error(JSON.stringify({
    error: 'GitHub CLI (gh) is not installed or not in PATH'
  }));
  process.exit(1);
}

// Check if gh is authenticated
// gh auth status exits with 0 if authenticated, regardless of output
try {
  execSync('gh auth status', { stdio: ['pipe', 'pipe', 'pipe'] });
} catch (error) {
  console.error(JSON.stringify({
    error: 'GitHub CLI is not authenticated. Run: gh auth login'
  }));
  process.exit(1);
}

// Build state filter
const includeClosed = includeClosedConfig === true || includeClosedConfig === 'true';
const stateFilter = includeClosed ? 'all' : 'open';

// Check for incremental sync - use LAST_SYNC_TIME from plugin loader
const lastSyncTime = process.env.LAST_SYNC_TIME || '';
let searchFilter = '';
let isIncremental = false;

if (lastSyncTime) {
  // Use yesterday's date to ensure we don't miss anything due to day boundary timing
  // GitHub search only supports date granularity, not datetime
  const lastSync = new Date(lastSyncTime);
  lastSync.setDate(lastSync.getDate() - 1); // Go back one day to be safe
  const searchDate = lastSync.toISOString().split('T')[0]; // YYYY-MM-DD
  searchFilter = `--search "updated:>${searchDate}"`;
  isIncremental = true;
}

// Fetch issues using gh CLI
// Use JSON output for structured data
const ghCommand = `gh issue list --repo ${repository} --state ${stateFilter} --limit ${limit} ${searchFilter} --json number,title,state,createdAt,closedAt,url,body,labels,assignees,milestone,updatedAt`;

let issues;
try {
  const output = execSync(ghCommand, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  issues = JSON.parse(output);
} catch (error) {
  console.error(JSON.stringify({
    error: `Failed to fetch issues from ${repository}: ${error.message}`
  }));
  process.exit(1);
}

// Transform to our schema
const entries = issues.map(issue => {
  // Build metadata object
  const metadata = {};

  if (issue.labels && issue.labels.length > 0) {
    metadata.labels = issue.labels.map(l => l.name);
  }

  if (issue.assignees && issue.assignees.length > 0) {
    metadata.assignees = issue.assignees.map(a => a.login);
  }

  if (issue.milestone) {
    metadata.milestone = issue.milestone.title;
  }

  if (issue.closedAt) {
    metadata.closed_at = issue.closedAt;
  }

  if (issue.updatedAt) {
    metadata.updated_at = issue.updatedAt;
  }

  // Store original GitHub data for reference
  metadata.repository = repository;

  return {
    id: String(issue.number),
    title: issue.title,
    state: issue.state.toLowerCase(), // OPEN -> open, CLOSED -> closed
    opened_at: issue.createdAt,
    url: issue.url,
    body: issue.body || null,
    metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
  };
});

// Output JSON
console.log(JSON.stringify({
  entries,
  total: issues.length,
  repository,
  state_filter: stateFilter,
  incremental: isIncremental
}));

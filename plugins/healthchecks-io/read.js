#!/usr/bin/env node

// Healthchecks.io Plugin - Read
// Fetches healthcheck monitors and outputs as issues
// Input: Config via PLUGIN_CONFIG environment variable
// Output: JSON with entries array (issues format)

const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');

const apiKeyEnv = config.api_key_env || 'HEALTHCHECKS_API_KEY';
const apiKey = process.env[apiKeyEnv];
const includePassing = config.include_passing || false;
const includePaused = config.include_paused || false;

if (!apiKey) {
  console.error(JSON.stringify({
    error: `API key not found in ${apiKeyEnv}`,
    entries: []
  }));
  process.exit(1);
}

async function fetchChecks() {
  const response = await fetch('https://healthchecks.io/api/v3/checks/', {
    headers: {
      'X-Api-Key': apiKey
    }
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function mapStatusToState(status) {
  // down, grace, new = failing = open
  // up = passing = closed
  // paused = excluded by default
  switch (status) {
    case 'down':
    case 'grace':
    case 'new':
      return 'open';
    case 'up':
      return 'closed';
    case 'paused':
      return 'closed'; // Treat paused as closed if included
    default:
      return 'open';
  }
}

function formatCheck(check) {
  const state = mapStatusToState(check.status);

  // Build body with useful info
  const bodyParts = [];
  if (check.desc) bodyParts.push(check.desc);
  bodyParts.push(`Status: ${check.status}`);
  if (check.schedule) bodyParts.push(`Schedule: ${check.schedule}`);
  if (check.tz) bodyParts.push(`Timezone: ${check.tz}`);
  if (check.n_pings !== undefined) bodyParts.push(`Total pings: ${check.n_pings}`);
  if (check.last_ping) bodyParts.push(`Last ping: ${check.last_ping}`);

  // Use last_ping as opened_at, or fall back to current time
  const openedAt = check.last_ping || new Date().toISOString();

  // Dashboard URL
  const url = `https://healthchecks.io/checks/${check.uuid}/details/`;

  return {
    id: check.uuid,
    title: check.name || 'Unnamed check',
    state: state,
    opened_at: openedAt,
    url: url,
    body: bodyParts.join('\n'),
    metadata: JSON.stringify({
      status: check.status,
      schedule: check.schedule,
      tz: check.tz,
      grace: check.grace,
      n_pings: check.n_pings,
      last_ping: check.last_ping,
      next_ping: check.next_ping,
      ping_url: check.ping_url,
      tags: check.tags
    })
  };
}

async function main() {
  try {
    const data = await fetchChecks();
    const checks = data.checks || [];

    // Filter checks based on settings
    const filtered = checks.filter(check => {
      // Always exclude paused unless explicitly included
      if (check.status === 'paused' && !includePaused) {
        return false;
      }
      // Exclude passing checks unless explicitly included
      if (check.status === 'up' && !includePassing) {
        return false;
      }
      return true;
    });

    const entries = filtered.map(formatCheck);

    // Count by status for metadata
    const statusCounts = {};
    for (const check of checks) {
      statusCounts[check.status] = (statusCounts[check.status] || 0) + 1;
    }

    console.log(JSON.stringify({
      entries: entries,
      metadata: {
        total_checks: checks.length,
        synced_checks: entries.length,
        status_counts: statusCounts,
        include_passing: includePassing,
        include_paused: includePaused
      }
    }));

  } catch (error) {
    console.error(JSON.stringify({
      error: error.message,
      entries: []
    }));
    process.exit(1);
  }
}

main();

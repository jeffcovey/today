#!/usr/bin/env node

// Read projects from GitHub Projects V2 using gh CLI GraphQL API
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with entries array
//
// Requires: gh CLI installed and authenticated with read:project scope
//   gh auth refresh -s read:project

import { execSync } from 'child_process';

// Clear environment tokens so gh uses its own OAuth session from `gh auth login`
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
delete process.env.GH_ENTERPRISE_TOKEN;

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const owner = config.owner;
const ownerType = config.type || 'user';
const repository = config.repository;
const includeClosed = config.include_closed === true || config.include_closed === 'true';
const limit = config.limit || 20;

if (!owner) {
  console.error(JSON.stringify({
    error: 'owner setting is required (GitHub username or organization name)'
  }));
  process.exit(1);
}

if (ownerType === 'repo' && !repository) {
  console.error(JSON.stringify({
    error: 'repository setting is required when type = repo'
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
try {
  execSync('gh auth status', { stdio: ['pipe', 'pipe', 'pipe'] });
} catch (error) {
  console.error(JSON.stringify({
    error: 'GitHub CLI is not authenticated. Run: gh auth login'
  }));
  process.exit(1);
}

// Build GraphQL query based on owner type
function buildQuery() {
  const projectFields = `
    id
    title
    number
    url
    shortDescription
    closed
    public
    updatedAt
    items(first: 100) {
      totalCount
      nodes {
        id
        type
        content {
          ... on Issue {
            number
            title
            state
            url
            repository {
              nameWithOwner
            }
          }
          ... on PullRequest {
            number
            title
            state
            url
            repository {
              nameWithOwner
            }
          }
        }
      }
    }
  `;

  if (ownerType === 'user') {
    return `
      query($login: String!, $first: Int!) {
        user(login: $login) {
          projectsV2(first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes { ${projectFields} }
          }
        }
      }
    `;
  } else if (ownerType === 'org') {
    return `
      query($login: String!, $first: Int!) {
        organization(login: $login) {
          projectsV2(first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes { ${projectFields} }
          }
        }
      }
    `;
  } else if (ownerType === 'repo') {
    return `
      query($owner: String!, $repo: String!, $first: Int!) {
        repository(owner: $owner, name: $repo) {
          projectsV2(first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes { ${projectFields} }
          }
        }
      }
    `;
  }
}

// Execute GraphQL query
let projects;
try {
  const query = buildQuery();
  let ghCommand;

  if (ownerType === 'repo') {
    ghCommand = `gh api graphql -f query='${query.replace(/'/g, "\\'")}' -F owner='${owner}' -F repo='${repository}' -F first=${limit}`;
  } else {
    ghCommand = `gh api graphql -f query='${query.replace(/'/g, "\\'")}' -F login='${owner}' -F first=${limit}`;
  }

  const output = execSync(ghCommand, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const result = JSON.parse(output);

  // Extract projects from the appropriate path
  if (ownerType === 'user') {
    projects = result.data?.user?.projectsV2?.nodes || [];
  } else if (ownerType === 'org') {
    projects = result.data?.organization?.projectsV2?.nodes || [];
  } else if (ownerType === 'repo') {
    projects = result.data?.repository?.projectsV2?.nodes || [];
  }
} catch (error) {
  // Check if it's a scope error
  if (error.message?.includes('read:project') || error.stderr?.includes('read:project')) {
    console.error(JSON.stringify({
      error: 'GitHub CLI needs read:project scope. Run: gh auth refresh -s read:project'
    }));
  } else {
    console.error(JSON.stringify({
      error: `Failed to fetch projects: ${error.message}`
    }));
  }
  process.exit(1);
}

// Filter closed projects if not included
if (!includeClosed) {
  projects = projects.filter(p => !p.closed);
}

// Transform to our schema
const entries = projects.map(project => {
  // Build metadata object
  const metadata = {
    github_id: project.id,
    owner: owner,
    owner_type: ownerType,
    public: project.public,
    updated_at: project.updatedAt
  };

  if (ownerType === 'repo') {
    metadata.repository = repository;
  }

  // Extract item information
  if (project.items) {
    metadata.item_count = project.items.totalCount;

    // Store issue/PR references
    const items = project.items.nodes
      .filter(item => item.content)
      .map(item => ({
        type: item.type,
        number: item.content.number,
        title: item.content.title,
        state: item.content.state?.toLowerCase(),
        url: item.content.url,
        repository: item.content.repository?.nameWithOwner
      }));

    if (items.length > 0) {
      metadata.items = items;
    }
  }

  // Calculate progress from items if available
  let progress = null;
  if (metadata.items && metadata.items.length > 0) {
    const closed = metadata.items.filter(i => i.state === 'closed' || i.state === 'merged').length;
    progress = Math.round((closed / metadata.items.length) * 100);
  }

  // Build unique ID
  const idPrefix = ownerType === 'repo' ? `${owner}/${repository}` : owner;

  return {
    id: `${idPrefix}#${project.number}`,
    title: project.title,
    description: project.shortDescription || null,
    status: project.closed ? 'completed' : 'active',
    priority: null, // GitHub Projects don't have priority
    topic: null,
    start_date: null,
    due_date: null,
    completed_at: null,
    progress: progress,
    review_frequency: null,
    last_reviewed: null,
    url: project.url,
    parent_id: null,
    metadata: JSON.stringify(metadata)
  };
});

// Output JSON
console.log(JSON.stringify({
  entries,
  total: entries.length,
  owner,
  owner_type: ownerType,
  include_closed: includeClosed
}));

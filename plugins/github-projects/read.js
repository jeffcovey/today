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
const defaultReviewFrequency = config.default_review_frequency || 'weekly';
const closedReviewFrequency = config.closed_review_frequency || 'never';
const staleness_days = config.staleness_days || 7;
const createDateFields = config.create_date_fields === true || config.create_date_fields === 'true';
const createPriorityField = config.create_priority_field === true || config.create_priority_field === 'true';
const createStatusField = config.create_status_field === true || config.create_status_field === 'true';
const createStageField = config.create_stage_field === true || config.create_stage_field === 'true';

// Priority options for the single-select field
const PRIORITY_OPTIONS = [
  { name: 'Highest', color: 'RED' },
  { name: 'High', color: 'ORANGE' },
  { name: 'Medium', color: 'YELLOW' },
  { name: 'Low', color: 'GREEN' },
  { name: 'Lowest', color: 'GRAY' }
];

// Status options for the single-select field (named "Project Status" to avoid conflict with built-in Status)
const STATUS_OPTIONS = [
  { name: 'Active', color: 'GREEN' },
  { name: 'Paused', color: 'YELLOW' },
  { name: 'Completed', color: 'PURPLE' },
  { name: 'Cancelled', color: 'GRAY' }
];
const STATUS_FIELD_NAME = 'Project Status';

// Stage options for the single-select field
const STAGE_OPTIONS = [
  { name: 'Front Stage', color: 'BLUE' },
  { name: 'Back Stage', color: 'ORANGE' },
  { name: 'Off Stage', color: 'GREEN' }
];
const STAGE_FIELD_NAME = 'Stage';

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

/**
 * Create a date field on a project if it doesn't exist
 * @param {string} projectId - GitHub project node ID
 * @param {string} fieldName - Name of the field to create
 * @returns {boolean} - Whether the field was created
 */
function createDateField(projectId, fieldName) {
  const mutation = `
    mutation {
      createProjectV2Field(input: {
        projectId: "${projectId}"
        dataType: DATE
        name: "${fieldName}"
      }) {
        projectV2Field {
          ... on ProjectV2Field {
            id
            name
          }
        }
      }
    }
  `;

  try {
    execSync(`gh api graphql -f query='${mutation.replace(/'/g, "\\'")}'`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch (error) {
    // Silently fail - likely missing write scope
    return false;
  }
}

/**
 * Create a priority single-select field on a project if it doesn't exist
 * @param {string} projectId - GitHub project node ID
 * @returns {boolean} - Whether the field was created
 */
function createPriorityFieldOnProject(projectId) {
  // Build options in GraphQL input syntax (not JSON)
  const optionsList = PRIORITY_OPTIONS.map(opt =>
    `{ name: "${opt.name}", color: ${opt.color}, description: "${opt.name} priority" }`
  ).join(', ');

  const mutation = `
    mutation {
      createProjectV2Field(input: {
        projectId: "${projectId}"
        dataType: SINGLE_SELECT
        name: "Priority"
        singleSelectOptions: [${optionsList}]
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField {
            id
            name
          }
        }
      }
    }
  `;

  try {
    execSync(`gh api graphql -f query='${mutation.replace(/'/g, "\\'")}'`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch (error) {
    // Silently fail - likely missing write scope
    return false;
  }
}

/**
 * Ensure a project has a Priority field
 * @param {Object} project - Project object with id and fields
 * @returns {boolean} - Whether the field was created
 */
function ensurePriorityField(project) {
  if (!project.fields?.nodes) return false;

  const fieldNames = project.fields.nodes
    .filter(f => f.name)
    .map(f => f.name.toLowerCase());

  const hasPriority = fieldNames.some(n => n === 'priority');

  if (!hasPriority) {
    return createPriorityFieldOnProject(project.id);
  }
  return false;
}

/**
 * Create a status single-select field on a project if it doesn't exist
 * @param {string} projectId - GitHub project node ID
 * @returns {boolean} - Whether the field was created
 */
function createStatusFieldOnProject(projectId) {
  // Build options in GraphQL input syntax (not JSON)
  const optionsList = STATUS_OPTIONS.map(opt =>
    `{ name: "${opt.name}", color: ${opt.color}, description: "${opt.name} status" }`
  ).join(', ');

  const mutation = `
    mutation {
      createProjectV2Field(input: {
        projectId: "${projectId}"
        dataType: SINGLE_SELECT
        name: "${STATUS_FIELD_NAME}"
        singleSelectOptions: [${optionsList}]
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField {
            id
            name
          }
        }
      }
    }
  `;

  try {
    execSync(`gh api graphql -f query='${mutation.replace(/'/g, "\\'")}'`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch (error) {
    // Silently fail - likely missing write scope
    return false;
  }
}

/**
 * Ensure a project has a Status field
 * @param {Object} project - Project object with id and fields
 * @returns {boolean} - Whether the field was created
 */
function ensureStatusField(project) {
  if (!project.fields?.nodes) return false;

  const fieldNames = project.fields.nodes
    .filter(f => f.name)
    .map(f => f.name.toLowerCase());

  const hasStatus = fieldNames.some(n => n === STATUS_FIELD_NAME.toLowerCase());

  if (!hasStatus) {
    return createStatusFieldOnProject(project.id);
  }
  return false;
}

/**
 * Create a stage single-select field on a project if it doesn't exist
 * @param {string} projectId - GitHub project node ID
 * @returns {boolean} - Whether the field was created
 */
function createStageFieldOnProject(projectId) {
  // Build options in GraphQL input syntax (not JSON)
  const optionsList = STAGE_OPTIONS.map(opt =>
    `{ name: "${opt.name}", color: ${opt.color}, description: "${opt.name.toLowerCase()} work" }`
  ).join(', ');

  const mutation = `
    mutation {
      createProjectV2Field(input: {
        projectId: "${projectId}"
        dataType: SINGLE_SELECT
        name: "${STAGE_FIELD_NAME}"
        singleSelectOptions: [${optionsList}]
      }) {
        projectV2Field {
          ... on ProjectV2SingleSelectField {
            id
            name
          }
        }
      }
    }
  `;

  try {
    execSync(`gh api graphql -f query='${mutation.replace(/'/g, "\\'")}'`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return true;
  } catch (error) {
    // Silently fail - likely missing write scope
    return false;
  }
}

/**
 * Ensure a project has a Stage field
 * @param {Object} project - Project object with id and fields
 * @returns {boolean} - Whether the field was created
 */
function ensureStageField(project) {
  if (!project.fields?.nodes) return false;

  const fieldNames = project.fields.nodes
    .filter(f => f.name)
    .map(f => f.name.toLowerCase());

  const hasStage = fieldNames.some(n => n === STAGE_FIELD_NAME.toLowerCase());

  if (!hasStage) {
    return createStageFieldOnProject(project.id);
  }
  return false;
}

/**
 * Ensure a project has Start Date and Due Date fields
 * @param {Object} project - Project object with id and fields
 * @returns {Object} - { startDateCreated, dueDateCreated }
 */
function ensureDateFields(project) {
  const result = { startDateCreated: false, dueDateCreated: false };

  if (!project.fields?.nodes) return result;

  const fieldNames = project.fields.nodes
    .filter(f => f.name)
    .map(f => f.name.toLowerCase());

  const hasStartDate = fieldNames.some(n => n === 'start date');
  const hasDueDate = fieldNames.some(n => n === 'due date');

  if (!hasStartDate) {
    result.startDateCreated = createDateField(project.id, 'Start Date');
  }
  if (!hasDueDate) {
    result.dueDateCreated = createDateField(project.id, 'Due Date');
  }

  return result;
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
    fields(first: 20) {
      nodes {
        ... on ProjectV2Field {
          id
          name
          dataType
        }
        ... on ProjectV2SingleSelectField {
          id
          name
          dataType
        }
        ... on ProjectV2IterationField {
          id
          name
          dataType
        }
      }
    }
    items(first: 100) {
      totalCount
      nodes {
        id
        type
        fieldValues(first: 10) {
          nodes {
            ... on ProjectV2ItemFieldDateValue {
              date
              field {
                ... on ProjectV2Field {
                  name
                }
              }
            }
            ... on ProjectV2ItemFieldSingleSelectValue {
              name
              field {
                ... on ProjectV2SingleSelectField {
                  name
                }
              }
            }
          }
        }
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

// Create date fields on projects that don't have them (if enabled)
if (createDateFields) {
  for (const project of projects) {
    ensureDateFields(project);
  }
}

// Create priority field on projects that don't have it (if enabled)
if (createPriorityField) {
  for (const project of projects) {
    ensurePriorityField(project);
  }
}

// Create status field on projects that don't have it (if enabled)
if (createStatusField) {
  for (const project of projects) {
    ensureStatusField(project);
  }
}

// Create stage field on projects that don't have it (if enabled)
if (createStageField) {
  for (const project of projects) {
    ensureStageField(project);
  }
}

/**
 * Calculate GitHub-native attention score and reasons
 * @param {Object} project - GitHub project data
 * @param {Object} metadata - Project metadata with items
 * @param {number} stalenessDays - Days before considering project stale
 * @returns {Object} { score: number, reasons: string[] }
 */
function calculateAttentionScore(project, metadata, stalenessDays) {
  const reasons = [];
  let score = 0;

  // Check for staleness (no recent updates)
  if (project.updatedAt) {
    const updatedDate = new Date(project.updatedAt);
    const daysSinceUpdate = Math.floor((Date.now() - updatedDate.getTime()) / (1000 * 60 * 60 * 24));

    if (daysSinceUpdate >= stalenessDays) {
      const staleDays = daysSinceUpdate;
      reasons.push(`no activity for ${staleDays} days`);

      // Scoring: stale projects get increasing scores
      if (staleDays >= 30) score += 75;      // Very stale
      else if (staleDays >= 14) score += 50; // Quite stale
      else if (staleDays >= stalenessDays) score += 25; // Mildly stale
    }
  }

  // Check for incomplete items (open issues/PRs)
  if (metadata.items && metadata.items.length > 0) {
    const openItems = metadata.items.filter(i => i.state === 'open').length;
    const totalItems = metadata.items.length;

    if (openItems > 0) {
      const openPercentage = Math.round((openItems / totalItems) * 100);

      if (openPercentage > 80) {
        reasons.push(`${openItems}/${totalItems} items incomplete (${openPercentage}%)`);
        score += 30; // Many incomplete items
      } else if (openPercentage > 50) {
        reasons.push(`${openItems}/${totalItems} items incomplete (${openPercentage}%)`);
        score += 15; // Some incomplete items
      }
    }
  }

  // Closed projects get low attention unless there are other issues
  if (project.closed && score === 0) {
    score = 0; // Completed projects need no attention
  }

  // Ensure score doesn't exceed 100
  score = Math.min(score, 100);

  return { score, reasons };
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

  // Extract item information, date field values, priority, status, and stage
  let projectStartDate = null;
  let projectDueDate = null;
  let projectPriority = null;
  let projectStatus = null;
  let projectStage = null;

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

    // Extract dates, priority, status, and stage from item field values
    // Look for "Start Date", "Due Date", "Priority", "Project Status", and "Stage" fields
    const startDates = [];
    const dueDates = [];
    const priorities = [];
    const statuses = [];
    const stages = [];

    for (const item of project.items.nodes) {
      if (!item.fieldValues?.nodes) continue;

      for (const fieldValue of item.fieldValues.nodes) {
        // Handle date fields
        if (fieldValue.date && fieldValue.field?.name) {
          const fieldName = fieldValue.field.name.toLowerCase();
          if (fieldName.includes('start')) {
            startDates.push(fieldValue.date);
          } else if (fieldName.includes('due') || fieldName.includes('end') || fieldName.includes('target')) {
            dueDates.push(fieldValue.date);
          }
        }

        // Handle single-select fields (Priority, Status, Stage)
        if (fieldValue.name && fieldValue.field?.name) {
          const fieldName = fieldValue.field.name.toLowerCase();
          if (fieldName === 'priority') {
            priorities.push(fieldValue.name.toLowerCase());
          } else if (fieldName === STATUS_FIELD_NAME.toLowerCase()) {
            statuses.push(fieldValue.name.toLowerCase());
          } else if (fieldName === STAGE_FIELD_NAME.toLowerCase()) {
            stages.push(fieldValue.name.toLowerCase().replace(/\s+/g, '-'));
          }
        }
      }
    }

    // Use earliest start date and latest due date
    if (startDates.length > 0) {
      startDates.sort();
      projectStartDate = startDates[0];
    }
    if (dueDates.length > 0) {
      dueDates.sort();
      projectDueDate = dueDates[dueDates.length - 1];
    }

    // Use highest priority found (first in priority order)
    if (priorities.length > 0) {
      const priorityOrder = ['highest', 'high', 'medium', 'low', 'lowest'];
      for (const p of priorityOrder) {
        if (priorities.includes(p)) {
          projectPriority = p;
          break;
        }
      }
      // If no match, use the first one found
      if (!projectPriority) {
        projectPriority = priorities[0];
      }
    }

    // Use most significant status found (first in status order)
    if (statuses.length > 0) {
      const statusOrder = ['paused', 'active', 'completed', 'cancelled'];
      for (const s of statusOrder) {
        if (statuses.includes(s)) {
          projectStatus = s;
          break;
        }
      }
      // If no match, use the first one found
      if (!projectStatus) {
        projectStatus = statuses[0];
      }
    }

    // Use the first stage found (stages are mutually exclusive)
    if (stages.length > 0) {
      projectStage = stages[0];
    }
  }

  // Add stage to metadata if present
  if (projectStage) {
    metadata.stage = projectStage;
  }

  // Calculate progress from items if available
  let progress = null;
  if (metadata.items && metadata.items.length > 0) {
    const closed = metadata.items.filter(i => i.state === 'closed' || i.state === 'merged').length;
    progress = Math.round((closed / metadata.items.length) * 100);
  }

  // Calculate GitHub-native attention score and reasons
  const attentionData = calculateAttentionScore(project, metadata, staleness_days);
  const attentionScore = attentionData.score;
  const attentionReasons = attentionData.reasons;

  // Set review frequency based on project status
  const reviewFrequency = project.closed ? closedReviewFrequency : defaultReviewFrequency;

  // Use GitHub project activity as last reviewed date
  const lastReviewed = project.updatedAt ? project.updatedAt.split('T')[0] : null;

  // Build unique ID
  const idPrefix = ownerType === 'repo' ? `${owner}/${repository}` : owner;

  // Determine status: use Status field if set, otherwise fall back to closed/open
  const finalStatus = projectStatus || (project.closed ? 'completed' : 'active');

  return {
    id: `${idPrefix}#${project.number}`,
    title: project.title,
    description: project.shortDescription || null,
    status: finalStatus,
    priority: projectPriority, // From Priority single-select field on items
    topic: null,
    start_date: projectStartDate,
    due_date: projectDueDate,
    completed_at: null,
    progress: progress,
    review_frequency: reviewFrequency,
    last_reviewed: lastReviewed,
    attention_score: attentionScore,
    attention_reasons: attentionReasons.length > 0 ? JSON.stringify(attentionReasons) : null,
    last_activity: project.updatedAt ? project.updatedAt.split('T')[0] : null,
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

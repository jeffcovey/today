#!/usr/bin/env node

// Write handler for github-projects plugin
// Supports updating project dates by setting date fields on the first item

import { execSync } from 'child_process';

// Clear environment tokens so gh uses its own OAuth session
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
delete process.env.GH_ENTERPRISE_TOKEN;

const args = JSON.parse(process.env.PLUGIN_WRITE_ARGS || '{}');

function output(result) {
  console.log(JSON.stringify(result));
}

// Execute a GraphQL query using gh CLI
function graphql(query) {
  try {
    const result = execSync(`gh api graphql -f query='${query.replace(/'/g, "\\'")}'`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return JSON.parse(result);
  } catch (error) {
    throw new Error(`GraphQL error: ${error.message}`);
  }
}

// Parse project ID to extract owner type, owner, and project number
// Format: "github-projects/source:owner#number" or just "owner#number"
function parseProjectId(projectId) {
  let id = projectId;

  // Remove source prefix if present
  if (id.includes(':')) {
    id = id.split(':').pop();
  }

  // Parse "owner#number" or "owner/repo#number"
  const match = id.match(/^(.+)#(\d+)$/);
  if (!match) {
    throw new Error(`Invalid project ID format: ${projectId}`);
  }

  const ownerPart = match[1];
  const number = parseInt(match[2], 10);

  // Check if it's org/repo format or just owner
  if (ownerPart.includes('/')) {
    const [owner, repo] = ownerPart.split('/');
    return { owner, repo, number, type: 'org' };
  }

  return { owner: ownerPart, number, type: 'user' };
}

// Get project details including field IDs and first item
async function getProjectDetails(owner, number, ownerType) {
  const ownerField = ownerType === 'user' ? 'user' : 'organization';

  const query = `
    query {
      ${ownerField}(login: "${owner}") {
        projectV2(number: ${number}) {
          id
          title
          fields(first: 20) {
            nodes {
              ... on ProjectV2Field {
                id
                name
                dataType
              }
            }
          }
          items(first: 1) {
            nodes {
              id
            }
          }
        }
      }
    }
  `;

  const result = graphql(query);
  const project = result.data?.[ownerField]?.projectV2;

  if (!project) {
    throw new Error(`Project not found: ${owner}#${number}`);
  }

  // Find date field IDs
  const fields = project.fields.nodes.filter(f => f.name);
  const startDateField = fields.find(f => f.name.toLowerCase() === 'start date');
  const dueDateField = fields.find(f => f.name.toLowerCase() === 'due date');

  // Get first item
  const firstItem = project.items.nodes[0];

  return {
    projectId: project.id,
    title: project.title,
    startDateFieldId: startDateField?.id,
    dueDateFieldId: dueDateField?.id,
    firstItemId: firstItem?.id,
  };
}

// Update a date field on an item
function updateItemDateField(projectId, itemId, fieldId, date) {
  const value = date ? `{ date: "${date}" }` : '{ date: null }';

  const mutation = `
    mutation {
      updateProjectV2ItemFieldValue(input: {
        projectId: "${projectId}"
        itemId: "${itemId}"
        fieldId: "${fieldId}"
        value: ${value}
      }) {
        projectV2Item { id }
      }
    }
  `;

  graphql(mutation);
}

// Clear a date field on an item
function clearItemDateField(projectId, itemId, fieldId) {
  const mutation = `
    mutation {
      clearProjectV2ItemFieldValue(input: {
        projectId: "${projectId}"
        itemId: "${itemId}"
        fieldId: "${fieldId}"
      }) {
        projectV2Item { id }
      }
    }
  `;

  graphql(mutation);
}

// Handle set-dates action
async function handleSetDates() {
  const { projectId, startDate, dueDate } = args;

  if (!projectId) {
    return output({ success: false, error: 'projectId is required' });
  }

  try {
    // Parse the project ID
    const { owner, number, type } = parseProjectId(projectId);

    // Get project details
    const details = await getProjectDetails(owner, number, type);

    if (!details.firstItemId) {
      return output({ success: false, error: 'Project has no items. Add an item first to set dates.' });
    }

    // Update start date if specified
    if (startDate !== undefined) {
      if (!details.startDateFieldId) {
        return output({ success: false, error: 'Project has no "Start Date" field. Enable create_date_fields in config.' });
      }

      if (startDate === null) {
        clearItemDateField(details.projectId, details.firstItemId, details.startDateFieldId);
      } else {
        updateItemDateField(details.projectId, details.firstItemId, details.startDateFieldId, startDate);
      }
    }

    // Update due date if specified
    if (dueDate !== undefined) {
      if (!details.dueDateFieldId) {
        return output({ success: false, error: 'Project has no "Due Date" field. Enable create_date_fields in config.' });
      }

      if (dueDate === null) {
        clearItemDateField(details.projectId, details.firstItemId, details.dueDateFieldId);
      } else {
        updateItemDateField(details.projectId, details.firstItemId, details.dueDateFieldId, dueDate);
      }
    }

    return output({
      success: true,
      updated: {
        project: details.title,
        itemId: details.firstItemId,
        startDate: startDate,
        dueDate: dueDate,
      }
    });
  } catch (error) {
    return output({ success: false, error: error.message });
  }
}

// Main
if (args.action === 'set-dates') {
  handleSetDates();
} else {
  output({ success: false, error: `Unknown action: ${args.action}` });
}

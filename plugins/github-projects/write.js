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
// ownerTypeHint can be passed from the caller if known (from metadata)
function parseProjectId(projectId, ownerTypeHint = null) {
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

  // Use hint if provided, otherwise default to 'user'
  const type = ownerTypeHint || 'user';
  return { owner: ownerPart, number, type };
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
              ... on ProjectV2SingleSelectField {
                id
                name
                dataType
                options {
                  id
                  name
                }
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

  // Find field IDs
  const fields = project.fields.nodes.filter(f => f.name);
  const startDateField = fields.find(f => f.name.toLowerCase() === 'start date');
  const dueDateField = fields.find(f => f.name.toLowerCase() === 'due date');
  const priorityField = fields.find(f => f.name.toLowerCase() === 'priority');
  const statusField = fields.find(f => f.name.toLowerCase() === 'project status');

  // Get first item
  const firstItem = project.items.nodes[0];

  return {
    projectId: project.id,
    title: project.title,
    startDateFieldId: startDateField?.id,
    dueDateFieldId: dueDateField?.id,
    priorityFieldId: priorityField?.id,
    priorityOptions: priorityField?.options || [],
    statusFieldId: statusField?.id,
    statusOptions: statusField?.options || [],
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

// Update a single-select field on an item (e.g., Priority)
function updateItemSingleSelectField(projectId, itemId, fieldId, optionId) {
  const mutation = `
    mutation {
      updateProjectV2ItemFieldValue(input: {
        projectId: "${projectId}"
        itemId: "${itemId}"
        fieldId: "${fieldId}"
        value: { singleSelectOptionId: "${optionId}" }
      }) {
        projectV2Item { id }
      }
    }
  `;

  graphql(mutation);
}

// Clear a single-select field on an item
function clearItemSingleSelectField(projectId, itemId, fieldId) {
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
    const { owner, number, type } = parseProjectId(projectId, args.ownerType);

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

// Handle set-priority action
async function handleSetPriority() {
  const { projectId, priority } = args;

  if (!projectId) {
    return output({ success: false, error: 'projectId is required' });
  }

  if (priority === undefined) {
    return output({ success: false, error: 'priority is required' });
  }

  try {
    // Parse the project ID
    const { owner, number, type } = parseProjectId(projectId, args.ownerType);

    // Get project details
    const details = await getProjectDetails(owner, number, type);

    if (!details.firstItemId) {
      return output({ success: false, error: 'Project has no items. Add an item first to set priority.' });
    }

    if (!details.priorityFieldId) {
      return output({ success: false, error: 'Project has no "Priority" field. Enable create_priority_field in config.' });
    }

    // Clear priority if null
    if (priority === null) {
      clearItemSingleSelectField(details.projectId, details.firstItemId, details.priorityFieldId);
      return output({
        success: true,
        updated: {
          project: details.title,
          itemId: details.firstItemId,
          priority: null,
        }
      });
    }

    // Find the option ID for the requested priority
    const normalizedPriority = priority.toLowerCase();
    const option = details.priorityOptions.find(
      opt => opt.name.toLowerCase() === normalizedPriority
    );

    if (!option) {
      const validOptions = details.priorityOptions.map(o => o.name.toLowerCase()).join(', ');
      return output({
        success: false,
        error: `Invalid priority "${priority}". Valid options: ${validOptions}`
      });
    }

    // Update the priority
    updateItemSingleSelectField(details.projectId, details.firstItemId, details.priorityFieldId, option.id);

    return output({
      success: true,
      updated: {
        project: details.title,
        itemId: details.firstItemId,
        priority: option.name,
      }
    });
  } catch (error) {
    return output({ success: false, error: error.message });
  }
}

// Handle set-status action
async function handleSetStatus() {
  const { projectId, status } = args;

  if (!projectId) {
    return output({ success: false, error: 'projectId is required' });
  }

  if (status === undefined) {
    return output({ success: false, error: 'status is required' });
  }

  try {
    // Parse the project ID
    const { owner, number, type } = parseProjectId(projectId, args.ownerType);

    // Get project details
    const details = await getProjectDetails(owner, number, type);

    if (!details.firstItemId) {
      return output({ success: false, error: 'Project has no items. Add an item first to set status.' });
    }

    if (!details.statusFieldId) {
      return output({ success: false, error: 'Project has no "Project Status" field. Enable create_status_field in config.' });
    }

    // Clear status if null
    if (status === null) {
      clearItemSingleSelectField(details.projectId, details.firstItemId, details.statusFieldId);
      return output({
        success: true,
        updated: {
          project: details.title,
          itemId: details.firstItemId,
          status: null,
        }
      });
    }

    // Find the option ID for the requested status
    const normalizedStatus = status.toLowerCase();
    const option = details.statusOptions.find(
      opt => opt.name.toLowerCase() === normalizedStatus
    );

    if (!option) {
      const validOptions = details.statusOptions.map(o => o.name.toLowerCase()).join(', ');
      return output({
        success: false,
        error: `Invalid status "${status}". Valid options: ${validOptions}`
      });
    }

    // Update the status
    updateItemSingleSelectField(details.projectId, details.firstItemId, details.statusFieldId, option.id);

    return output({
      success: true,
      updated: {
        project: details.title,
        itemId: details.firstItemId,
        status: option.name,
      }
    });
  } catch (error) {
    return output({ success: false, error: error.message });
  }
}

// Main
if (args.action === 'set-dates') {
  handleSetDates();
} else if (args.action === 'set-priority') {
  handleSetPriority();
} else if (args.action === 'set-status') {
  handleSetStatus();
} else {
  output({ success: false, error: `Unknown action: ${args.action}` });
}

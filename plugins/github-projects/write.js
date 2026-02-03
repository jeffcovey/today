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
          items(first: 50) {
            nodes {
              id
              content {
                ... on Issue {
                  number
                  title
                }
              }
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
  const nextReviewDateField = fields.find(f => f.name.toLowerCase() === 'next review date');

  // Get first item and review metadata item
  const firstItem = project.items.nodes[0];
  const reviewMetadataItem = project.items.nodes.find(item =>
    item.content?.title?.includes('[META]') &&
    item.content?.title?.includes('Review Schedule')
  );

  return {
    projectId: project.id,
    title: project.title,
    startDateFieldId: startDateField?.id,
    dueDateFieldId: dueDateField?.id,
    priorityFieldId: priorityField?.id,
    priorityOptions: priorityField?.options || [],
    statusFieldId: statusField?.id,
    statusOptions: statusField?.options || [],
    nextReviewDateFieldId: nextReviewDateField?.id,
    firstItemId: firstItem?.id,
    reviewMetadataItem: reviewMetadataItem,
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

// Create a "Next Review Date" field on a project
function createNextReviewDateField(projectId) {
  const mutation = `
    mutation {
      createProjectV2Field(input: {
        projectId: "${projectId}"
        dataType: DATE
        name: "Next Review Date"
      }) {
        projectV2Field {
          ... on ProjectV2Field {
            id
            name
            dataType
          }
        }
      }
    }
  `;

  const result = graphql(mutation);
  return result.data?.createProjectV2Field?.projectV2Field?.id;
}

// Get repository for project (assumes project contains issues from one repository)
function getProjectRepository(owner, number, ownerType) {
  const ownerField = ownerType === 'user' ? 'user' : 'organization';

  const query = `
    query {
      ${ownerField}(login: "${owner}") {
        projectV2(number: ${number}) {
          items(first: 10) {
            nodes {
              content {
                ... on Issue {
                  repository {
                    name
                    owner {
                      login
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = graphql(query);
  const items = result.data?.[ownerField]?.projectV2?.items?.nodes || [];

  for (const item of items) {
    if (item.content?.repository) {
      return {
        owner: item.content.repository.owner.login,
        name: item.content.repository.name
      };
    }
  }

  // Default fallback - use project owner (works for org projects)
  return { owner, name: owner === 'OlderGay-Men' ? 'OlderGay.Men' : 'today' };
}

// Create metadata issue for review scheduling
function createMetadataIssue(repoOwner, repoName, projectTitle, reviewDate, frequency) {
  const dayOfWeek = new Date(reviewDate).toLocaleDateString('en-US', { weekday: 'long' });
  const body = `This issue tracks review scheduling for the ${projectTitle} project.

**Next Review Date:** ${reviewDate} (${dayOfWeek})
**Review Frequency:** ${frequency}

This is a metadata issue for project management - not a development task.`;

  const mutation = `
    mutation {
      createIssue(input: {
        repositoryId: "${getRepositoryId(repoOwner, repoName)}"
        title: "[META] ${projectTitle} Review Schedule"
        body: "${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"
      }) {
        issue {
          id
          number
          url
        }
      }
    }
  `;

  const result = graphql(mutation);
  return result.data?.createIssue?.issue;
}

// Get repository ID for creating issues
function getRepositoryId(owner, name) {
  const query = `
    query {
      repository(owner: "${owner}", name: "${name}") {
        id
      }
    }
  `;

  const result = graphql(query);
  return result.data?.repository?.id;
}

// Add issue to project
function addIssueToProject(projectId, issueId) {
  const mutation = `
    mutation {
      addProjectV2ItemById(input: {
        projectId: "${projectId}"
        contentId: "${issueId}"
      }) {
        item {
          id
        }
      }
    }
  `;

  const result = graphql(mutation);
  return result.data?.addProjectV2ItemById?.item?.id;
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

// Handle set-review-date action
async function handleSetReviewDate() {
  const { projectId, reviewDate, frequency } = args;

  if (!projectId) {
    return output({ success: false, error: 'projectId is required' });
  }

  if (!reviewDate) {
    return output({ success: false, error: 'reviewDate is required' });
  }

  // Validate date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(reviewDate)) {
    return output({ success: false, error: 'Invalid date format. Use YYYY-MM-DD' });
  }

  try {
    // Parse the project ID
    const { owner, number, type } = parseProjectId(projectId, args.ownerType);

    // Get project details
    const details = await getProjectDetails(owner, number, type);

    // Create "Next Review Date" field if it doesn't exist
    let nextReviewDateFieldId = details.nextReviewDateFieldId;
    if (!nextReviewDateFieldId) {
      nextReviewDateFieldId = createNextReviewDateField(details.projectId);
      if (!nextReviewDateFieldId) {
        return output({ success: false, error: 'Failed to create Next Review Date field' });
      }
    }

    // Get repository for creating metadata issue
    const repo = getProjectRepository(owner, number, type);

    // Create or update metadata issue
    let metadataIssue;
    const finalFrequency = frequency || 'weekly';

    if (details.reviewMetadataItem) {
      // Update existing metadata issue (close and create new one for simplicity)
      // TODO: Could implement update logic instead
      metadataIssue = createMetadataIssue(repo.owner, repo.name, details.title, reviewDate, finalFrequency);
    } else {
      // Create new metadata issue
      metadataIssue = createMetadataIssue(repo.owner, repo.name, details.title, reviewDate, finalFrequency);
    }

    if (!metadataIssue) {
      return output({ success: false, error: 'Failed to create metadata issue' });
    }

    // Add metadata issue to project
    const metadataItemId = addIssueToProject(details.projectId, metadataIssue.id);

    if (!metadataItemId) {
      return output({ success: false, error: 'Failed to add metadata issue to project' });
    }

    // Set the review date on the metadata issue
    updateItemDateField(details.projectId, metadataItemId, nextReviewDateFieldId, reviewDate);

    return output({
      success: true,
      updated: {
        project: details.title,
        reviewDate: reviewDate,
        frequency: finalFrequency,
        metadataIssue: {
          number: metadataIssue.number,
          url: metadataIssue.url,
          itemId: metadataItemId,
        },
        fieldId: nextReviewDateFieldId,
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
} else if (args.action === 'set-review-date') {
  handleSetReviewDate();
} else {
  output({ success: false, error: `Unknown action: ${args.action}` });
}

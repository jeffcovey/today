#!/usr/bin/env node

// Write handler for markdown-projects plugin
// Supports updating project frontmatter fields like start_date, target_date

import fs from 'fs';
import path from 'path';

const projectRoot = process.env.PROJECT_ROOT || process.cwd();
const args = JSON.parse(process.env.PLUGIN_WRITE_ARGS || '{}');

function output(result) {
  console.log(JSON.stringify(result));
}

// Parse YAML frontmatter from markdown content
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { frontmatter: {}, body: content, raw: '' };

  const raw = match[1];
  const body = content.slice(match[0].length);
  const frontmatter = {};

  const lines = raw.split('\n');
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.substring(0, colonIndex).trim();
    let value = line.substring(colonIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    frontmatter[key] = value || null;
  }

  return { frontmatter, body, raw };
}

// Update a frontmatter field in the raw YAML
function updateFrontmatterField(raw, key, value) {
  const lines = raw.split('\n');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${key}:`)) {
      if (value === null) {
        // Remove the line
        lines.splice(i, 1);
      } else {
        lines[i] = `${key}: ${value}`;
      }
      found = true;
      break;
    }
  }

  // Add the field if not found and value is not null
  if (!found && value !== null) {
    // Find a good place to insert (after similar fields or at end)
    let insertIndex = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('start_date:') || lines[i].startsWith('target_date:') ||
          lines[i].startsWith('due_date:') || lines[i].startsWith('end_date:')) {
        insertIndex = i + 1;
      }
    }
    lines.splice(insertIndex, 0, `${key}: ${value}`);
  }

  return lines.join('\n');
}

// Valid priority values (normalized to lowercase)
const VALID_PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'];

// Valid status values (normalized to lowercase)
const VALID_STATUSES = ['active', 'paused', 'completed', 'cancelled'];

// Valid stage values (normalized to lowercase)
const VALID_STAGES = ['front-stage', 'back-stage', 'off-stage'];

// Handle set-dates action
function handleSetDates() {
  const { projectId, startDate, dueDate } = args;

  if (!projectId) {
    return output({ success: false, error: 'projectId is required' });
  }

  // Project ID for markdown-projects is the file path (e.g., "vault/projects/my-project.md")
  // Extract it from the full ID which might have source prefix
  let filePath = projectId;
  if (filePath.includes(':')) {
    filePath = filePath.split(':').pop();
  }

  const fullPath = path.join(projectRoot, filePath);

  if (!fs.existsSync(fullPath)) {
    return output({ success: false, error: `Project file not found: ${filePath}` });
  }

  // Read and parse the file
  const content = fs.readFileSync(fullPath, 'utf8');
  const { frontmatter, body, raw } = parseFrontmatter(content);

  if (!raw) {
    return output({ success: false, error: 'Project file has no frontmatter' });
  }

  // Update the frontmatter
  let updatedRaw = raw;

  if (startDate !== undefined) {
    updatedRaw = updateFrontmatterField(updatedRaw, 'start_date', startDate);
  }

  if (dueDate !== undefined) {
    // markdown-projects uses target_date for due date
    updatedRaw = updateFrontmatterField(updatedRaw, 'target_date', dueDate);
  }

  // Write back the file
  const newContent = `---\n${updatedRaw}\n---${body}`;
  fs.writeFileSync(fullPath, newContent, 'utf8');

  return output({
    success: true,
    updated: {
      file: filePath,
      startDate: startDate !== undefined ? startDate : frontmatter.start_date,
      dueDate: dueDate !== undefined ? dueDate : frontmatter.target_date,
    }
  });
}

// Handle set-priority action
function handleSetPriority() {
  const { projectId, priority } = args;

  if (!projectId) {
    return output({ success: false, error: 'projectId is required' });
  }

  if (priority === undefined) {
    return output({ success: false, error: 'priority is required' });
  }

  // Project ID for markdown-projects is the file path
  let filePath = projectId;
  if (filePath.includes(':')) {
    filePath = filePath.split(':').pop();
  }

  const fullPath = path.join(projectRoot, filePath);

  if (!fs.existsSync(fullPath)) {
    return output({ success: false, error: `Project file not found: ${filePath}` });
  }

  // Validate priority value
  const normalizedPriority = priority === null ? null : priority.toLowerCase();
  if (normalizedPriority !== null && !VALID_PRIORITIES.includes(normalizedPriority)) {
    return output({
      success: false,
      error: `Invalid priority "${priority}". Valid options: ${VALID_PRIORITIES.join(', ')}`
    });
  }

  // Read and parse the file
  const content = fs.readFileSync(fullPath, 'utf8');
  const { frontmatter, body, raw } = parseFrontmatter(content);

  if (!raw) {
    return output({ success: false, error: 'Project file has no frontmatter' });
  }

  // Update the frontmatter
  const updatedRaw = updateFrontmatterField(raw, 'priority', normalizedPriority);

  // Write back the file
  const newContent = `---\n${updatedRaw}\n---${body}`;
  fs.writeFileSync(fullPath, newContent, 'utf8');

  return output({
    success: true,
    updated: {
      file: filePath,
      priority: normalizedPriority,
    }
  });
}

// Handle set-status action
function handleSetStatus() {
  const { projectId, status } = args;

  if (!projectId) {
    return output({ success: false, error: 'projectId is required' });
  }

  if (status === undefined) {
    return output({ success: false, error: 'status is required' });
  }

  // Project ID for markdown-projects is the file path
  let filePath = projectId;
  if (filePath.includes(':')) {
    filePath = filePath.split(':').pop();
  }

  const fullPath = path.join(projectRoot, filePath);

  if (!fs.existsSync(fullPath)) {
    return output({ success: false, error: `Project file not found: ${filePath}` });
  }

  // Validate status value
  const normalizedStatus = status === null ? null : status.toLowerCase();
  if (normalizedStatus !== null && !VALID_STATUSES.includes(normalizedStatus)) {
    return output({
      success: false,
      error: `Invalid status "${status}". Valid options: ${VALID_STATUSES.join(', ')}`
    });
  }

  // Read and parse the file
  const content = fs.readFileSync(fullPath, 'utf8');
  const { frontmatter, body, raw } = parseFrontmatter(content);

  if (!raw) {
    return output({ success: false, error: 'Project file has no frontmatter' });
  }

  // Update the frontmatter
  const updatedRaw = updateFrontmatterField(raw, 'status', normalizedStatus);

  // Write back the file
  const newContent = `---\n${updatedRaw}\n---${body}`;
  fs.writeFileSync(fullPath, newContent, 'utf8');

  return output({
    success: true,
    updated: {
      file: filePath,
      status: normalizedStatus,
    }
  });
}

// Handle set-stage action
function handleSetStage() {
  const { projectId, stage } = args;

  if (!projectId) {
    return output({ success: false, error: 'projectId is required' });
  }

  if (stage === undefined) {
    return output({ success: false, error: 'stage is required' });
  }

  // Project ID for markdown-projects is the file path
  let filePath = projectId;
  if (filePath.includes(':')) {
    filePath = filePath.split(':').pop();
  }

  const fullPath = path.join(projectRoot, filePath);

  if (!fs.existsSync(fullPath)) {
    return output({ success: false, error: `Project file not found: ${filePath}` });
  }

  // Validate stage value
  const normalizedStage = stage === null ? null : stage.toLowerCase();
  if (normalizedStage !== null && !VALID_STAGES.includes(normalizedStage)) {
    return output({
      success: false,
      error: `Invalid stage "${stage}". Valid options: ${VALID_STAGES.join(', ')}`
    });
  }

  // Read and parse the file
  const content = fs.readFileSync(fullPath, 'utf8');
  const { frontmatter, body, raw } = parseFrontmatter(content);

  if (!raw) {
    return output({ success: false, error: 'Project file has no frontmatter' });
  }

  // Update the frontmatter
  const updatedRaw = updateFrontmatterField(raw, 'stage', normalizedStage);

  // Write back the file
  const newContent = `---\n${updatedRaw}\n---${body}`;
  fs.writeFileSync(fullPath, newContent, 'utf8');

  return output({
    success: true,
    updated: {
      file: filePath,
      stage: normalizedStage,
    }
  });
}

// Handle set-review-date action
function handleSetReviewDate() {
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

  // Project ID for markdown-projects is the file path
  let filePath = projectId;
  if (filePath.includes(':')) {
    filePath = filePath.split(':').pop();
  }

  const fullPath = path.join(projectRoot, filePath);

  if (!fs.existsSync(fullPath)) {
    return output({ success: false, error: `Project file not found: ${filePath}` });
  }

  // Read and parse the file
  const content = fs.readFileSync(fullPath, 'utf8');
  const { frontmatter, body, raw } = parseFrontmatter(content);

  if (!raw) {
    return output({ success: false, error: 'Project file has no frontmatter' });
  }

  // Calculate last_reviewed date based on review frequency
  // Target review date minus frequency = last_reviewed date
  const reviewDateObj = new Date(reviewDate);

  // Get current frequency or use provided frequency
  const reviewFrequency = frequency || frontmatter.review_frequency || 'weekly';

  // Calculate days to subtract based on frequency
  const frequencyDays = {
    daily: 1,
    weekly: 7,
    monthly: 30,
    quarterly: 90,
    yearly: 365
  };

  const daysToSubtract = frequencyDays[reviewFrequency] || 7;

  // Calculate last_reviewed date
  const lastReviewedObj = new Date(reviewDateObj);
  lastReviewedObj.setDate(lastReviewedObj.getDate() - daysToSubtract);
  const lastReviewedDate = lastReviewedObj.toISOString().split('T')[0];

  // Update the frontmatter
  let updatedRaw = raw;

  // Set review frequency if provided
  if (frequency) {
    updatedRaw = updateFrontmatterField(updatedRaw, 'review_frequency', frequency);
  }

  // Set last_reviewed date to calculated value
  updatedRaw = updateFrontmatterField(updatedRaw, 'last_reviewed', lastReviewedDate);

  // Write back the file
  const newContent = `---\n${updatedRaw}\n---${body}`;
  fs.writeFileSync(fullPath, newContent, 'utf8');

  return output({
    success: true,
    updated: {
      file: filePath,
      reviewDate: reviewDate,
      frequency: frequency || frontmatter.review_frequency || 'weekly',
      lastReviewedDate: lastReviewedDate,
      calculatedDaysBack: daysToSubtract,
    }
  });
}

// Main
if (args.action === 'set-dates') {
  handleSetDates();
} else if (args.action === 'set-priority') {
  handleSetPriority();
} else if (args.action === 'set-status') {
  handleSetStatus();
} else if (args.action === 'set-stage') {
  handleSetStage();
} else if (args.action === 'set-review-date') {
  handleSetReviewDate();
} else {
  output({ success: false, error: `Unknown action: ${args.action}` });
}

#!/usr/bin/env node

// Sync projects from markdown files (Obsidian format with YAML frontmatter)
// Input: Config via environment variables (PLUGIN_CONFIG as JSON)
// Output: JSON object with entries and metadata

import fs from 'fs';
import path from 'path';

// Read config from environment
const config = JSON.parse(process.env.PLUGIN_CONFIG || '{}');
const projectRoot = process.env.PROJECT_ROOT || process.cwd();

const directory = config.directory || `${process.env.VAULT_PATH}/projects`;
const excludePaths = (config.exclude_paths || 'templates,zz-attachments')
  .split(',')
  .map(p => p.trim())
  .filter(Boolean);
const completedFolder = config.completed_folder || 'completed';

const rootDir = path.join(projectRoot, directory);

// Check if directory exists
if (!fs.existsSync(rootDir)) {
  console.log(JSON.stringify({
    entries: [],
    metadata: {
      message: `Projects directory not found: ${directory}`,
      hint: 'Create the directory and add project .md files with YAML frontmatter'
    }
  }));
  process.exit(0);
}

// Priority mapping (frontmatter values to schema values)
const priorityMap = {
  'urgent': 'highest',
  'high': 'high',
  'medium': 'medium',
  'low': 'low',
  'lowest': 'lowest'
};

// Status normalization
const statusMap = {
  'planning': 'planning',
  'active': 'active',
  'in-progress': 'active',  // Normalize to active
  'in_progress': 'active',
  'on-hold': 'on_hold',
  'on_hold': 'on_hold',
  'paused': 'on_hold',
  'inactive': 'on_hold',
  'postponed': 'on_hold',
  'completed': 'completed',
  'done': 'completed',
  'archived': 'archived'
};

// Find all markdown files in project directory
function findProjectFiles(dir, relativeTo = dir) {
  const files = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(relativeTo, fullPath);

      // Skip excluded paths
      if (excludePaths.some(exc => relativePath.startsWith(exc) || entry.name.startsWith(exc))) {
        continue;
      }

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        files.push(...findProjectFiles(fullPath, relativeTo));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}: ${error.message}`);
  }

  return files;
}

// Parse YAML frontmatter from markdown content
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const data = {};

  // Simple YAML parser for flat key-value pairs
  const lines = yaml.split('\n');
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.substring(0, colonIndex).trim();
    let value = line.substring(colonIndex + 1).trim();

    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Skip empty values
    if (!value) continue;

    // Parse arrays (simple format: [item1, item2])
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
    }

    // Parse numbers
    if (/^\d+$/.test(value)) {
      value = parseInt(value, 10);
    }

    data[key] = value;
  }

  return data;
}

// Extract description/goal from markdown content (first paragraph after frontmatter)
function extractDescription(content) {
  // Remove frontmatter
  const withoutFrontmatter = content.replace(/^---\n[\s\S]*?\n---\n*/, '');

  // Find first non-empty paragraph that's not a heading or task
  const lines = withoutFrontmatter.split('\n');
  let description = '';

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip headings, empty lines, tasks, code blocks, images
    if (!trimmed ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('- [') ||
        trimmed.startsWith('```') ||
        trimmed.startsWith('![') ||
        trimmed.startsWith('**Open Tasks:**') ||
        trimmed.startsWith('> [!')) {
      continue;
    }

    // Look for Goal: line specifically
    if (trimmed.startsWith('**Goal:**')) {
      description = trimmed.replace('**Goal:**', '').trim();
      break;
    }
  }

  return description || null;
}

// Process project files
const projectFiles = findProjectFiles(rootDir);
const entries = [];

for (const filePath of projectFiles) {
  const relativePath = path.relative(projectRoot, filePath);

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(`Error reading ${filePath}: ${error.message}`);
    continue;
  }

  const frontmatter = parseFrontmatter(content);

  // Get title from frontmatter or filename
  const fileName = path.basename(filePath, '.md');
  const title = frontmatter.title || fileName.replace(/-/g, ' ');

  // Determine if in completed folder
  const relativeToProjects = path.relative(rootDir, filePath);
  const isInCompletedFolder = relativeToProjects.startsWith(completedFolder + path.sep);

  // Determine status
  let status = 'active';  // Default
  if (frontmatter.status) {
    status = statusMap[frontmatter.status.toLowerCase()] || frontmatter.status;
  }
  // Override if in completed folder
  if (isInCompletedFolder && status !== 'archived') {
    status = 'completed';
  }

  // Map priority
  let priority = null;
  if (frontmatter.priority) {
    priority = priorityMap[frontmatter.priority.toLowerCase()] || frontmatter.priority;
  }

  // Map category to topic
  const topic = frontmatter.category || frontmatter.topic || null;

  // Extract dates
  const startDate = frontmatter.start_date || null;
  const dueDate = frontmatter.target_date || frontmatter.target_completion || frontmatter.due_date || null;

  // Progress
  const progress = typeof frontmatter.percent_done === 'number' ? frontmatter.percent_done : null;

  // Review fields (optional - highlight when present)
  const reviewFrequency = frontmatter.review_frequency || null;
  const lastReviewed = frontmatter.last_reviewed || null;

  // Extract description
  const description = extractDescription(content);

  // Build metadata for extra fields
  const metadata = {};
  if (frontmatter.cover_image) metadata.cover_image = frontmatter.cover_image;
  if (frontmatter.related_projects) metadata.related_projects = frontmatter.related_projects;
  metadata.file_path = relativePath;

  // Define how to query related items (tasks) for this project
  // bin/projects will use this to find tasks generically
  metadata.item_query = {
    table: 'tasks',
    id_pattern: `markdown-tasks/local:${relativePath}:%`,
    title_field: 'title',
    status_field: 'status',
    status_open: 'open',
    status_closed: 'completed'
  };

  // Add any other frontmatter fields we didn't explicitly handle
  const handledFields = [
    'title', 'status', 'priority', 'category', 'topic',
    'start_date', 'target_date', 'target_completion', 'due_date',
    'percent_done', 'review_frequency', 'last_reviewed',
    'cover_image', 'related_projects', 'cssclasses'
  ];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!handledFields.includes(key)) {
      metadata[key] = value;
    }
  }

  entries.push({
    id: relativePath,
    title,
    description,
    status,
    priority,
    topic,
    start_date: startDate,
    due_date: dueDate,
    completed_at: status === 'completed' ? null : null,  // Could parse from file mtime if needed
    progress,
    review_frequency: reviewFrequency,
    last_reviewed: lastReviewed,
    url: null,
    parent_id: null,
    metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null
  });
}

// Output JSON
// Note: We intentionally don't include files_processed to force full sync.
// This ensures stale entries are cleaned up when project files are renamed/deleted.
console.log(JSON.stringify({
  entries
}));

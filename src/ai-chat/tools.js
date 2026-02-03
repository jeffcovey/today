/**
 * AI Chat Tools for Vercel AI SDK
 *
 * Provides tools that the AI can use to:
 * - Edit the current file being discussed
 * - Query the database (using schemas from plugin-schemas.js)
 * - Run bin/ commands
 */

import { tool } from 'ai';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { getAbsoluteVaultPath, getFullConfig } from '../config.js';
import { schemas, getTableName } from '../plugin-schemas.js';

// Get the project root (parent of src/)
const PROJECT_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '../..');

/**
 * Execute a command and return its output
 */
async function executeCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd || PROJECT_ROOT,
      env: { ...process.env, ...options.env },
      timeout: options.timeout || 30000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout, stderr });
      } else {
        resolve({ success: false, output: stdout, stderr, exitCode: code });
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Get available bin/ commands with their descriptions
 */
function getAvailableBinCommands() {
  // Extract command info from plugin-schemas.js AI metadata
  const commands = new Map();

  for (const [type, schema] of Object.entries(schemas)) {
    if (schema.ai?.queryInstructions) {
      // Parse commands from queryInstructions
      const lines = schema.ai.queryInstructions.split('\n');
      for (const line of lines) {
        const match = line.match(/bin\/(\w+)/g);
        if (match) {
          for (const cmd of match) {
            const name = cmd.replace('bin/', '');
            if (!commands.has(name)) {
              commands.set(name, schema.ai.name);
            }
          }
        }
      }
    }
    if (schema.ai?.defaultCommand) {
      const match = schema.ai.defaultCommand.match(/bin\/(\w+)/g);
      if (match) {
        for (const cmd of match) {
          const name = cmd.replace('bin/', '');
          if (!commands.has(name)) {
            commands.set(name, schema.ai.name);
          }
        }
      }
    }
  }

  return commands;
}

/**
 * Get available database tables from plugin-schemas
 */
function getAvailableTables() {
  const tables = [];
  for (const [type, schema] of Object.entries(schemas)) {
    if (schema.table) {
      tables.push({
        name: schema.table,
        pluginType: type,
        description: schema.ai?.name || type,
        fields: Object.entries(schema.fields).map(([name, field]) => ({
          name,
          type: field.sqlType,
          description: field.description,
        })),
      });
    }
  }
  return tables;
}

/**
 * Create the edit_file tool
 * @param {string} filePath - The full path to the file being edited
 */
export function createEditFileTool(filePath) {
  return tool({
    description: `Edit the markdown file currently being discussed using search-and-replace. The file is located at: ${filePath}. Find the exact text to change and replace it with new text.`,
    inputSchema: z.object({
      oldText: z.string().describe('The exact text to find and replace. Must match exactly (including whitespace and newlines). Include enough context to make the match unique.'),
      newText: z.string().describe('The new text to replace it with. Can be empty string to delete the old text.'),
    }),
    execute: async ({ oldText, newText }) => {
      try {
        // Verify the file exists and is within the vault
        const vaultPath = getAbsoluteVaultPath();
        const resolvedPath = path.resolve(filePath);

        if (!resolvedPath.startsWith(vaultPath)) {
          return { success: false, error: 'Cannot edit files outside the vault' };
        }

        // Read current content
        const currentContent = await fs.readFile(resolvedPath, 'utf-8');

        // Check if oldText exists in the file
        if (!currentContent.includes(oldText)) {
          return {
            success: false,
            error: 'Could not find the specified text in the file. Make sure it matches exactly.',
            hint: 'The text you provided was not found. Check for exact whitespace and newlines.',
          };
        }

        // Check if oldText appears multiple times
        const occurrences = currentContent.split(oldText).length - 1;
        if (occurrences > 1) {
          return {
            success: false,
            error: `The text appears ${occurrences} times in the file. Include more surrounding context to make it unique.`,
          };
        }

        // Perform the replacement
        const newContent = currentContent.replace(oldText, newText);

        // Write the updated content
        await fs.writeFile(resolvedPath, newContent, 'utf-8');

        return {
          success: true,
          message: `File updated successfully: ${path.relative(vaultPath, resolvedPath)}`,
          bytesChanged: Math.abs(newText.length - oldText.length),
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
  });
}

/**
 * Create the create_file tool
 */
export function createCreateFileTool() {
  return tool({
    description: `Create a new file in the vault. Use this to create new documents, attachments, or any other files the user requests. The file path should be relative to the vault root (e.g., "projects/attachments/letter.html").`,
    inputSchema: z.object({
      filePath: z.string().describe('The path for the new file, relative to the vault root (e.g., "projects/attachments/letter.html")'),
      content: z.string().describe('The content to write to the file'),
    }),
    execute: async ({ filePath, content }) => {
      try {
        const vaultPath = getAbsoluteVaultPath();

        // Normalize the path (remove leading slash if present)
        const normalizedPath = filePath.replace(/^\//, '');
        const fullPath = path.join(vaultPath, normalizedPath);
        const resolvedPath = path.resolve(fullPath);

        // Security check: ensure the path is within the vault
        if (!resolvedPath.startsWith(vaultPath)) {
          return { success: false, error: 'Cannot create files outside the vault' };
        }

        // Check if file already exists
        try {
          await fs.access(resolvedPath);
          return { success: false, error: `File already exists: ${normalizedPath}. Use edit_file to modify existing files.` };
        } catch {
          // File doesn't exist, good to proceed
        }

        // Create parent directories if they don't exist
        const parentDir = path.dirname(resolvedPath);
        await fs.mkdir(parentDir, { recursive: true });

        // Write the file
        await fs.writeFile(resolvedPath, content, 'utf-8');

        return {
          success: true,
          message: `File created successfully: ${normalizedPath}`,
          path: normalizedPath,
          size: content.length,
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
  });
}

/**
 * Create the query_database tool
 */
export function createQueryDatabaseTool() {
  const tables = getAvailableTables();
  const tableDescriptions = tables
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n');

  return tool({
    description: `Query the SQLite database containing user data from various plugins.

Available tables:
${tableDescriptions}

Use standard SQL SELECT queries. The database is read-only for safety.`,
    inputSchema: z.object({
      query: z.string().describe('SQL SELECT query to execute. Only SELECT queries are allowed.'),
    }),
    execute: async ({ query }) => {
      try {
        // Validate it's a SELECT query
        const trimmedQuery = query.trim().toLowerCase();
        if (!trimmedQuery.startsWith('select')) {
          return { success: false, error: 'Only SELECT queries are allowed' };
        }

        // Disallow dangerous patterns
        const dangerous = ['drop', 'delete', 'update', 'insert', 'alter', 'create', ';'];
        for (const pattern of dangerous) {
          if (trimmedQuery.includes(pattern) && pattern !== ';') {
            return { success: false, error: `Query contains forbidden keyword: ${pattern}` };
          }
        }

        // Get database path from config
        const config = getFullConfig();
        const dbPath = config.database?.path || path.join(PROJECT_ROOT, '.data', 'today.db');

        // Execute query using sqlite3 CLI
        const result = await executeCommand('sqlite3', ['-json', '-readonly', dbPath, query]);

        if (!result.success) {
          return { success: false, error: result.stderr || 'Query failed' };
        }

        // Parse JSON output
        let rows;
        try {
          rows = result.output.trim() ? JSON.parse(result.output) : [];
        } catch {
          // sqlite3 might return plain text for some queries
          rows = result.output;
        }

        return {
          success: true,
          rowCount: Array.isArray(rows) ? rows.length : 'N/A',
          results: rows,
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
  });
}

/**
 * Create the run_command tool for bin/ commands
 */
export function createRunCommandTool() {
  const availableCommands = getAvailableBinCommands();
  const commandList = Array.from(availableCommands.entries())
    .map(([cmd, desc]) => `- bin/${cmd}: ${desc}`)
    .join('\n');

  return tool({
    description: `Run a bin/ command from the Today CLI toolkit.

Available commands:
${commandList}

Usage patterns:
- track add <duration> "<description>" - Add entry ending now (e.g., track add 10m "meeting")
- track start "<description>" - Start a timer
- track stop - Stop current timer
- tasks today - Show today's tasks
- calendar today - Show today's calendar

IMPORTANT: Use positional arguments, not flags. If a command fails, report the error to the user.`,
    inputSchema: z.object({
      command: z.string().describe('The command name without "bin/" prefix (e.g., "calendar", "tasks", "track")'),
      args: z.string().optional().describe('Positional arguments for the command. Example for track: "add 10m talking with John"'),
    }),
    execute: async ({ command, args }) => {
      try {
        // Validate command is in allowed list
        const allowed = getAvailableBinCommands();
        if (!allowed.has(command)) {
          return {
            success: false,
            error: `Unknown command: ${command}. Available: ${Array.from(allowed.keys()).join(', ')}`,
          };
        }

        // Build command path
        const cmdPath = path.join(PROJECT_ROOT, 'bin', command);

        // Parse args into array
        const argArray = args ? args.split(/\s+/).filter(Boolean) : [];

        // Execute
        const result = await executeCommand(cmdPath, argArray, {
          timeout: 60000, // 1 minute timeout for commands
        });

        return {
          success: result.success,
          output: result.output,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
  });
}

/**
 * Create all tools for a chat session
 * @param {Object} options
 * @param {string} options.filePath - Full path to the file being discussed (for edit tool)
 * @param {boolean} options.includeEdit - Whether to include the edit_file tool (default: true)
 * @param {boolean} options.includeCreate - Whether to include create_file tool (default: true)
 * @param {boolean} options.includeDatabase - Whether to include query_database tool (default: true)
 * @param {boolean} options.includeCommands - Whether to include run_command tool (default: true)
 */
export function createChatTools(options = {}) {
  const {
    filePath,
    includeEdit = true,
    includeCreate = true,
    includeDatabase = true,
    includeCommands = true,
  } = options;

  const tools = {};

  if (includeEdit && filePath) {
    tools.edit_file = createEditFileTool(filePath);
  }

  if (includeCreate) {
    tools.create_file = createCreateFileTool();
  }

  if (includeDatabase) {
    tools.query_database = createQueryDatabaseTool();
  }

  if (includeCommands) {
    tools.run_command = createRunCommandTool();
  }

  return tools;
}

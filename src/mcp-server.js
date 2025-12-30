/**
 * MCP (Model Context Protocol) Server for Today
 *
 * Exposes Today's functionality to AI assistants via the MCP protocol.
 * Provides tools for actions, resources for data access, and prompts for workflows.
 *
 * Usage:
 *   bin/mcp-server
 *
 * Configure in Claude Desktop:
 *   {
 *     "mcpServers": {
 *       "today": {
 *         "command": "/path/to/today/bin/mcp-server"
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getDatabase } from './database-service.js';
import {
  discoverPlugins,
  getEnabledPlugins,
  getPluginAccess,
  writeEntryAndSync,
  getWritableSource,
  ensureSyncForType,
} from './plugin-loader.js';
import { schemas, getTableName } from './plugin-schemas.js';
import { getTodayDate } from './date-utils.js';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Create and configure the MCP server
 */
export function createMCPServer() {
  const server = new Server(
    {
      name: 'today',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    }
  );

  // === TOOLS ===
  // Tools are actions the AI can perform

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [];

    // Get enabled plugins to determine available tools
    const enabledPlugins = await getEnabledPlugins();
    const pluginTypes = new Set(enabledPlugins.map(p => p.plugin.type));

    // Task tools (if tasks plugin enabled)
    if (pluginTypes.has('tasks')) {
      tools.push({
        name: 'create_task',
        description: 'Create a new task',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title/description' },
            priority: {
              type: 'string',
              enum: ['highest', 'high', 'medium', 'low', 'lowest'],
              description: 'Task priority level',
            },
            due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
            scheduled_date: { type: 'string', description: 'Scheduled date in YYYY-MM-DD format' },
            stage: {
              type: 'string',
              enum: ['front-stage', 'back-stage', 'off-stage'],
              description: 'Task stage classification',
            },
            topics: {
              type: 'array',
              items: { type: 'string' },
              description: 'Topic tags for the task',
            },
            source: { type: 'string', description: 'Plugin source to use (if multiple task plugins)' },
          },
          required: ['title'],
        },
      });

      tools.push({
        name: 'complete_task',
        description: 'Mark a task as completed',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'Full task ID from the database' },
            title: { type: 'string', description: 'Task title for verification (optional but recommended)' },
          },
          required: ['task_id'],
        },
      });

      tools.push({
        name: 'list_tasks',
        description: 'List tasks with optional filters',
        inputSchema: {
          type: 'object',
          properties: {
            today_only: { type: 'boolean', description: 'Only show tasks due/scheduled for today' },
            include_completed: { type: 'boolean', description: 'Include completed tasks' },
            stage: { type: 'string', description: 'Filter by stage (front-stage, back-stage, off-stage)' },
            priority: { type: 'string', description: 'Filter by priority' },
            limit: { type: 'number', description: 'Maximum number of tasks to return' },
          },
        },
      });
    }

    // Event tools (if events plugin enabled)
    if (pluginTypes.has('events')) {
      tools.push({
        name: 'create_event',
        description: 'Create a new calendar event',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Event title' },
            start_date: { type: 'string', description: 'Start datetime in ISO format (YYYY-MM-DDTHH:MM:SS)' },
            end_date: { type: 'string', description: 'End datetime in ISO format' },
            location: { type: 'string', description: 'Event location' },
            description: { type: 'string', description: 'Event description' },
            all_day: { type: 'boolean', description: 'Whether this is an all-day event' },
            source: { type: 'string', description: 'Calendar source to use (if multiple)' },
          },
          required: ['title', 'start_date'],
        },
      });

      tools.push({
        name: 'list_events',
        description: 'List calendar events',
        inputSchema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Date to show events for (YYYY-MM-DD), defaults to today' },
            days: { type: 'number', description: 'Number of days to show (default: 1)' },
          },
        },
      });
    }

    // Time tracking tools (if time-logs plugin enabled)
    if (pluginTypes.has('time-logs')) {
      tools.push({
        name: 'start_timer',
        description: 'Start time tracking for an activity',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'What you are working on' },
            source: { type: 'string', description: 'Time tracking source to use' },
          },
          required: ['description'],
        },
      });

      tools.push({
        name: 'stop_timer',
        description: 'Stop the currently running timer',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Time tracking source' },
          },
        },
      });
    }

    // General tools
    tools.push({
      name: 'sync_data',
      description: 'Sync data from all enabled plugins',
      inputSchema: {
        type: 'object',
        properties: {
          plugin_type: { type: 'string', description: 'Specific plugin type to sync (e.g., tasks, events)' },
        },
      },
    });

    tools.push({
      name: 'query_database',
      description: 'Run a read-only SQL query against the Today database',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL SELECT query to run' },
          limit: { type: 'number', description: 'Maximum rows to return (default: 100)' },
        },
        required: ['sql'],
      },
    });

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const db = getDatabase();

    try {
      switch (name) {
        case 'create_task': {
          const entry = {
            action: 'add',
            title: args.title,
            priority: args.priority || 'medium',
            stage: args.stage,
            topics: args.topics,
            due_date: args.due_date,
            scheduled_date: args.scheduled_date,
          };

          const result = await writeEntryAndSync('tasks', entry, {
            db,
            sourceFilter: args.source,
          });

          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error: ${result.error}` }],
              isError: true,
            };
          }

          return {
            content: [{
              type: 'text',
              text: `Created task: ${args.title}${result.writeResult?.line ? `\n${result.writeResult.line}` : ''}`,
            }],
          };
        }

        case 'complete_task': {
          const taskId = args.task_id;
          const firstColon = taskId.indexOf(':');
          if (firstColon === -1) {
            return {
              content: [{ type: 'text', text: 'Error: Invalid task ID format' }],
              isError: true,
            };
          }

          const source = taskId.substring(0, firstColon);
          const pluginId = taskId.substring(firstColon + 1);

          const entry = {
            action: 'complete',
            id: pluginId,
            title: args.title,
          };

          const result = await writeEntryAndSync('tasks', entry, {
            db,
            sourceFilter: source,
          });

          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error: ${result.error}` }],
              isError: true,
            };
          }

          return {
            content: [{ type: 'text', text: 'Task completed successfully' }],
          };
        }

        case 'list_tasks': {
          ensureSyncForType(db, 'tasks');

          const conditions = [];
          const params = [];

          if (!args.include_completed) {
            conditions.push("status = 'open'");
          }

          if (args.today_only) {
            const today = getTodayDate();
            conditions.push("(due_date <= ? OR json_extract(metadata, '$.scheduled_date') <= ?)");
            params.push(today, today);
          }

          if (args.stage) {
            conditions.push("json_extract(metadata, '$.stage') = ?");
            params.push(args.stage);
          }

          if (args.priority) {
            conditions.push('priority = ?');
            params.push(args.priority);
          }

          const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
          const limit = args.limit || 50;

          const sql = `
            SELECT id, title, status, priority, due_date, metadata, source
            FROM tasks
            ${whereClause}
            ORDER BY
              CASE priority
                WHEN 'highest' THEN 1
                WHEN 'high' THEN 2
                WHEN 'medium' THEN 3
                WHEN 'low' THEN 4
                WHEN 'lowest' THEN 5
                ELSE 6
              END,
              due_date NULLS LAST
            LIMIT ?
          `;

          const tasks = db.prepare(sql).all(...params, limit);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(tasks, null, 2),
            }],
          };
        }

        case 'create_event': {
          const entry = {
            action: 'create',
            event: {
              title: args.title,
              start_date: args.start_date,
              end_date: args.end_date || args.start_date,
              location: args.location,
              description: args.description,
              all_day: args.all_day,
            },
          };

          const result = await writeEntryAndSync('events', entry, {
            db,
            sourceFilter: args.source,
          });

          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error: ${result.error}` }],
              isError: true,
            };
          }

          return {
            content: [{
              type: 'text',
              text: `Created event: ${args.title}`,
            }],
          };
        }

        case 'list_events': {
          ensureSyncForType(db, 'events');

          const targetDate = args.date || getTodayDate();
          const days = args.days || 1;

          const endDate = new Date(targetDate);
          endDate.setDate(endDate.getDate() + days);
          const endDateStr = endDate.toISOString().split('T')[0];

          const events = db.prepare(`
            SELECT id, title, start_date, end_date, location, calendar_name, source
            FROM events
            WHERE date(start_date) >= ? AND date(start_date) < ?
            ORDER BY start_date
          `).all(targetDate, endDateStr);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify(events, null, 2),
            }],
          };
        }

        case 'start_timer': {
          const entry = {
            action: 'start',
            description: args.description,
          };

          const result = await writeEntryAndSync('time-logs', entry, {
            db,
            sourceFilter: args.source,
          });

          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error: ${result.error}` }],
              isError: true,
            };
          }

          return {
            content: [{
              type: 'text',
              text: `Started timer: ${args.description}`,
            }],
          };
        }

        case 'stop_timer': {
          const entry = { action: 'stop' };

          const result = await writeEntryAndSync('time-logs', entry, {
            db,
            sourceFilter: args.source,
          });

          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error: ${result.error}` }],
              isError: true,
            };
          }

          return {
            content: [{
              type: 'text',
              text: 'Timer stopped',
            }],
          };
        }

        case 'sync_data': {
          try {
            const typeArg = args.plugin_type ? `--type ${args.plugin_type}` : '';
            execSync(`bin/plugins sync ${typeArg}`, {
              cwd: PROJECT_ROOT,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            db.refresh();

            return {
              content: [{
                type: 'text',
                text: `Synced ${args.plugin_type || 'all plugins'} successfully`,
              }],
            };
          } catch (error) {
            return {
              content: [{ type: 'text', text: `Sync error: ${error.message}` }],
              isError: true,
            };
          }
        }

        case 'query_database': {
          // Security: Only allow SELECT queries
          const sql = args.sql.trim();
          if (!sql.toUpperCase().startsWith('SELECT')) {
            return {
              content: [{ type: 'text', text: 'Error: Only SELECT queries are allowed' }],
              isError: true,
            };
          }

          const limit = args.limit || 100;
          // Add LIMIT if not present
          const limitedSql = sql.toUpperCase().includes('LIMIT')
            ? sql
            : `${sql} LIMIT ${limit}`;

          try {
            const results = db.prepare(limitedSql).all();
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(results, null, 2),
              }],
            };
          } catch (error) {
            return {
              content: [{ type: 'text', text: `Query error: ${error.message}` }],
              isError: true,
            };
          }
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });

  // === RESOURCES ===
  // Resources provide read access to data

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [];

    // Get enabled plugins to determine available resources
    const enabledPlugins = await getEnabledPlugins();
    const pluginTypes = new Set(enabledPlugins.map(p => p.plugin.type));

    if (pluginTypes.has('tasks')) {
      resources.push({
        uri: 'today://tasks',
        name: 'Tasks',
        description: 'Current tasks from all enabled task plugins',
        mimeType: 'application/json',
      });

      resources.push({
        uri: 'today://tasks/today',
        name: 'Tasks Due Today',
        description: 'Tasks due or scheduled for today',
        mimeType: 'application/json',
      });
    }

    if (pluginTypes.has('events')) {
      resources.push({
        uri: 'today://events',
        name: 'Calendar Events',
        description: 'Upcoming calendar events',
        mimeType: 'application/json',
      });

      resources.push({
        uri: 'today://events/today',
        name: "Today's Events",
        description: 'Events scheduled for today',
        mimeType: 'application/json',
      });
    }

    if (pluginTypes.has('time-logs')) {
      resources.push({
        uri: 'today://time-logs',
        name: 'Time Logs',
        description: 'Recent time tracking entries',
        mimeType: 'application/json',
      });
    }

    if (pluginTypes.has('diary')) {
      resources.push({
        uri: 'today://diary',
        name: 'Diary Entries',
        description: 'Recent diary/journal entries',
        mimeType: 'application/json',
      });
    }

    // Context is always available
    resources.push({
      uri: 'today://context',
      name: 'Current Context',
      description: 'Current plans, weather, and other contextual information',
      mimeType: 'text/plain',
    });

    resources.push({
      uri: 'today://plugins',
      name: 'Enabled Plugins',
      description: 'List of enabled plugins and their capabilities',
      mimeType: 'application/json',
    });

    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const db = getDatabase();

    try {
      if (uri === 'today://tasks') {
        ensureSyncForType(db, 'tasks');
        const tasks = db.prepare(`
          SELECT id, title, status, priority, due_date, metadata, source
          FROM tasks
          WHERE status = 'open'
          ORDER BY
            CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 ELSE 6 END,
            due_date NULLS LAST
          LIMIT 100
        `).all();

        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(tasks, null, 2),
          }],
        };
      }

      if (uri === 'today://tasks/today') {
        ensureSyncForType(db, 'tasks');
        const today = getTodayDate();
        const tasks = db.prepare(`
          SELECT id, title, status, priority, due_date, metadata, source
          FROM tasks
          WHERE status = 'open'
            AND (due_date <= ? OR json_extract(metadata, '$.scheduled_date') <= ?)
          ORDER BY
            CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 ELSE 6 END,
            due_date NULLS LAST
        `).all(today, today);

        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(tasks, null, 2),
          }],
        };
      }

      if (uri === 'today://events') {
        ensureSyncForType(db, 'events');
        const today = getTodayDate();
        const events = db.prepare(`
          SELECT id, title, start_date, end_date, location, calendar_name, source
          FROM events
          WHERE date(start_date) >= ?
          ORDER BY start_date
          LIMIT 50
        `).all(today);

        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(events, null, 2),
          }],
        };
      }

      if (uri === 'today://events/today') {
        ensureSyncForType(db, 'events');
        const today = getTodayDate();
        const events = db.prepare(`
          SELECT id, title, start_date, end_date, location, calendar_name, source
          FROM events
          WHERE date(start_date) = ?
          ORDER BY start_date
        `).all(today);

        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(events, null, 2),
          }],
        };
      }

      if (uri === 'today://time-logs') {
        ensureSyncForType(db, 'time-logs');
        const today = getTodayDate();
        const logs = db.prepare(`
          SELECT id, start_time, end_time, duration_minutes, description, source
          FROM time_logs
          WHERE date(start_time) >= date(?, '-7 days')
          ORDER BY start_time DESC
          LIMIT 50
        `).all(today);

        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(logs, null, 2),
          }],
        };
      }

      if (uri === 'today://diary') {
        ensureSyncForType(db, 'diary');
        const logs = db.prepare(`
          SELECT id, date, content, metadata, source
          FROM diary
          ORDER BY date DESC
          LIMIT 10
        `).all();

        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(logs, null, 2),
          }],
        };
      }

      if (uri === 'today://context') {
        try {
          const context = execSync('bin/context show', {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          return {
            contents: [{
              uri,
              mimeType: 'text/plain',
              text: context,
            }],
          };
        } catch {
          return {
            contents: [{
              uri,
              mimeType: 'text/plain',
              text: 'Context unavailable',
            }],
          };
        }
      }

      if (uri === 'today://plugins') {
        const enabledPlugins = await getEnabledPlugins();
        const plugins = enabledPlugins.map(({ plugin, sources }) => ({
          name: plugin.name,
          displayName: plugin.displayName,
          type: plugin.type,
          access: getPluginAccess(plugin),
          sources: sources.map(s => s.sourceName),
        }));

        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(plugins, null, 2),
          }],
        };
      }

      return {
        contents: [{
          uri,
          mimeType: 'text/plain',
          text: `Unknown resource: ${uri}`,
        }],
      };
    } catch (error) {
      return {
        contents: [{
          uri,
          mimeType: 'text/plain',
          text: `Error reading resource: ${error.message}`,
        }],
      };
    }
  });

  // === PROMPTS ===
  // Prompts are pre-defined conversation starters

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: 'daily_planning',
          description: 'Help plan the day based on tasks, events, and context',
          arguments: [
            {
              name: 'focus_area',
              description: 'Optional focus area for today (e.g., "deep work", "meetings")',
              required: false,
            },
          ],
        },
        {
          name: 'weekly_review',
          description: 'Review the past week and plan for next week',
        },
        {
          name: 'task_triage',
          description: 'Help prioritize and organize tasks',
          arguments: [
            {
              name: 'criteria',
              description: 'Criteria for prioritization (e.g., "urgent", "impact")',
              required: false,
            },
          ],
        },
      ],
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const db = getDatabase();

    switch (name) {
      case 'daily_planning': {
        // Gather context for daily planning
        ensureSyncForType(db, 'tasks');
        ensureSyncForType(db, 'events');

        const today = getTodayDate();

        const tasks = db.prepare(`
          SELECT title, priority, due_date, metadata
          FROM tasks
          WHERE status = 'open'
            AND (due_date <= ? OR json_extract(metadata, '$.scheduled_date') <= ?)
          ORDER BY CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 ELSE 3 END
          LIMIT 20
        `).all(today, today);

        const events = db.prepare(`
          SELECT title, start_date, end_date, location
          FROM events
          WHERE date(start_date) = ?
          ORDER BY start_date
        `).all(today);

        let context = '';
        try {
          context = execSync('bin/context show', {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {
          // Context unavailable
        }

        const focusArea = args?.focus_area ? `\n\nFocus Area: ${args.focus_area}` : '';

        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Help me plan my day.${focusArea}

## Today's Events
${events.length > 0 ? events.map(e => `- ${e.start_date.substring(11, 16)}: ${e.title}${e.location ? ` @ ${e.location}` : ''}`).join('\n') : 'No events scheduled'}

## Tasks Due Today
${tasks.length > 0 ? tasks.map(t => `- [${t.priority || 'medium'}] ${t.title}`).join('\n') : 'No tasks due'}

## Context
${context || 'No additional context available'}

Based on this information, help me:
1. Identify the top 3 priorities for today
2. Suggest a rough schedule that accounts for events
3. Flag any potential conflicts or concerns
4. Recommend tasks that could be deferred if needed`,
              },
            },
          ],
        };
      }

      case 'weekly_review': {
        ensureSyncForType(db, 'tasks');

        const today = getTodayDate();
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const weekAgoStr = weekAgo.toISOString().split('T')[0];

        const completedTasks = db.prepare(`
          SELECT title, completed_at
          FROM tasks
          WHERE status = 'completed'
            AND date(completed_at) >= ?
          ORDER BY completed_at DESC
        `).all(weekAgoStr);

        const openTasks = db.prepare(`
          SELECT title, priority, due_date
          FROM tasks
          WHERE status = 'open'
          ORDER BY CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 ELSE 3 END
          LIMIT 30
        `).all();

        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Help me conduct a weekly review.

## Completed This Week (${completedTasks.length} tasks)
${completedTasks.slice(0, 15).map(t => `- ${t.title}`).join('\n') || 'No tasks completed'}
${completedTasks.length > 15 ? `... and ${completedTasks.length - 15} more` : ''}

## Open Tasks (${openTasks.length} total)
${openTasks.slice(0, 20).map(t => `- [${t.priority || 'medium'}] ${t.title}${t.due_date ? ` (due: ${t.due_date})` : ''}`).join('\n')}

Please help me:
1. Celebrate wins from this week
2. Identify any patterns or insights
3. Highlight tasks that need attention next week
4. Suggest any tasks that should be broken down or delegated`,
              },
            },
          ],
        };
      }

      case 'task_triage': {
        ensureSyncForType(db, 'tasks');

        const tasks = db.prepare(`
          SELECT id, title, priority, due_date, metadata, source
          FROM tasks
          WHERE status = 'open'
          ORDER BY created_at DESC
          LIMIT 50
        `).all();

        const criteria = args?.criteria || 'urgency and importance';

        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Help me triage and prioritize my tasks based on ${criteria}.

## Open Tasks (${tasks.length})
${tasks.map(t => {
  const meta = t.metadata ? JSON.parse(t.metadata) : {};
  return `- [${t.priority || 'none'}] ${t.title}${t.due_date ? ` (due: ${t.due_date})` : ''}${meta.stage ? ` #${meta.stage}` : ''}`;
}).join('\n')}

Please help me:
1. Identify which tasks are truly urgent vs just feeling urgent
2. Suggest priority adjustments
3. Group related tasks that could be batched
4. Flag any tasks that might be candidates for deletion or delegation`,
              },
            },
          ],
        };
      }

      default:
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Unknown prompt: ${name}`,
              },
            },
          ],
        };
    }
  });

  return server;
}

/**
 * Start the MCP server with stdio transport
 */
export async function startMCPServer() {
  const server = createMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

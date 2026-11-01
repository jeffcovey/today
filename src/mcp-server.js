/**
 * MCP (Model Context Protocol) Server for Today
 *
 * Exposes Today's functionality to AI assistants via the MCP protocol.
 * Provides tools for actions, resources for data access, and prompts for workflows.
 *
 * Usage:
 *   bin/mcp-server          stdio, for a client on the same machine
 *   [mcp] enabled = true    in config.toml serves it over HTTP at /mcp
 *                           inside the web server (see src/web-mcp.js)
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
  syncPluginSource,
  syncAllPlugins,
  getAIInstructionsByType,
} from './plugin-loader.js';
import { schemas, getTableName } from './plugin-schemas.js';
import { getTodayDate, sqlLocalDate } from './date-utils.js';
import {
  syncForRead,
  waitForReadSyncs,
  staleNote,
  listTasks,
  formatTaskList,
  LIST_TASKS_DEFAULT_LIMIT,
  LIST_TASKS_MAX_LIMIT,
} from './mcp-reads.js';
import {
  listEventsForDays,
  listUpcomingEvents,
  formatEventList,
  eventTimeLabel,
  buildCreateEvent,
  isoInZone,
  timeZoneInfo,
  timeZoneLine,
  LIST_EVENTS_MAX_DAYS,
} from './mcp-events.js';
import {
  PROJECT_TOOL_DEFINITIONS,
  PROJECT_WRITE_TOOLS,
  listProjectsTool,
  getProjectTool,
  markProjectReviewed,
} from './mcp-projects.js';
import { getAbsoluteVaultPath } from './config.js';
import { addGuidanceToTools, buildServerInstructions, buildContextText } from './mcp-guidance.js';
import { readLiveContext } from './mcp-live-context.js';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

async function aiInstructionsByType() {
  try {
    return await getAIInstructionsByType();
  } catch {
    return null;
  }
}

// Tools that change something: hidden and refused on a read-only connection.
export const WRITE_TOOLS = new Set([
  'create_task', 'complete_task', 'create_event', 'start_timer', 'stop_timer', 'sync_data',
  ...PROJECT_WRITE_TOOLS,
]);

/**
 * Create and configure the MCP server
 */
export function createMCPServer({ readOnly = false } = {}) {
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
      instructions: buildServerInstructions(),
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
        description: 'List tasks with optional filters. The reply starts with a line giving how many tasks matched and whether more pages exist; when has_more is true, call again with next_offset as offset to get the rest.',
        inputSchema: {
          type: 'object',
          properties: {
            today_only: { type: 'boolean', description: 'Only show tasks due/scheduled for today' },
            include_completed: { type: 'boolean', description: 'Include completed tasks' },
            stage: { type: 'string', description: 'Filter by stage (front-stage, back-stage, off-stage)' },
            priority: { type: 'string', description: 'Filter by priority' },
            limit: { type: 'number', description: `Maximum number of tasks to return (default: ${LIST_TASKS_DEFAULT_LIMIT}, max: ${LIST_TASKS_MAX_LIMIT})` },
            offset: { type: 'number', description: 'Number of matching tasks to skip, for paging (default: 0)' },
          },
        },
      });
    }

    // Event tools (if events plugin enabled)
    if (pluginTypes.has('events')) {
      tools.push({
        name: 'create_event',
        description: `Create a new calendar event. Times without an offset are read in the user's configured time zone (currently ${timeZoneInfo().user_timezone}) unless timezone is given.`,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Event title' },
            start_date: { type: 'string', description: 'Start, ISO 8601. With Z or an offset (2026-11-05T14:00:00-05:00) it is used as given; without one (2026-11-05T14:00:00) it is a local time in timezone, or in the user\'s configured zone. YYYY-MM-DD for an all-day event.' },
            end_date: { type: 'string', description: 'End, in the same form as start_date (default: start_date). For all-day events, the day after the last day.' },
            timezone: { type: 'string', description: 'IANA time zone for start/end times given without an offset, e.g. Europe/London when booking something in another city (default: the user\'s configured zone)' },
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
        description: 'List calendar events overlapping one or more days in the user\'s configured time zone. The reply starts with that zone, its UTC offset, the current time and today\'s date. Timed events give start/end in the user\'s zone with offset plus start_utc/end_utc; all-day events give start_date and an exclusive end_date.',
        inputSchema: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'First local day to show (YYYY-MM-DD), defaults to today in the user\'s zone' },
            days: { type: 'number', description: `Number of days to show (default: 1, max: ${LIST_EVENTS_MAX_DAYS})` },
          },
        },
      });
    }

    // Project tools (if projects plugin enabled)
    if (pluginTypes.has('projects')) {
      tools.push(...PROJECT_TOOL_DEFINITIONS);
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

    tools.push({
      name: 'get_context',
      description: "The user's context, as Today's own AI sees it: the current time and time zone, the user's profile, their instructions overall and for every data source, and live context (today's stage, plan, weather, vault changes). Call it at the start of a conversation.",
      inputSchema: {
        type: 'object',
        properties: {
          include_live: { type: 'boolean', description: 'Include live context-plugin output (default: true; slower)' },
        },
      },
    });

    // Filter first, so guidance for a type whose tools are hidden here goes
    // on query_database instead.
    const visible = readOnly ? tools.filter(tool => !WRITE_TOOLS.has(tool.name)) : tools;
    addGuidanceToTools(visible, await aiInstructionsByType());

    return { tools: visible };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (readOnly && WRITE_TOOLS.has(name)) {
      return {
        content: [{ type: 'text', text: `Error: ${name} is not available on this read-only connection` }],
        isError: true,
      };
    }
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
          const sync = await syncForRead(db, 'tasks');
          const result = listTasks(db, args);
          const note = staleNote('tasks', sync);
          return {
            content: [
              { type: 'text', text: timeZoneLine(timeZoneInfo()) },
              ...(note ? [{ type: 'text', text: note }] : []),
              { type: 'text', text: formatTaskList(result) },
            ],
          };
        }

        case 'create_event': {
          const created = buildCreateEvent(args);
          const entry = { action: 'create', event: created.event };

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
              text: `Created event: ${args.title}` + (created.startInstant
                ? ` at ${isoInZone(created.startInstant, created.timezone)} (${created.timezone})`
                : ` on ${String(args.start_date).slice(0, 10)} (all day)`),
            }],
          };
        }

        case 'list_events': {
          const sync = await syncForRead(db, 'events');

          const result = listEventsForDays(db, args);

          const note = staleNote('calendar', sync);
          return {
            content: [
              ...(note ? [{ type: 'text', text: note }] : []),
              { type: 'text', text: formatEventList(result) },
            ],
          };
        }

        case 'list_projects': {
          await ensureSyncForType(db, 'projects');
          const { summary, projects } = listProjectsTool(db, args || {}, { today: getTodayDate() });
          return {
            content: [{ type: 'text', text: `${summary}\n${JSON.stringify(projects, null, 2)}` }],
          };
        }

        case 'get_project': {
          await ensureSyncForType(db, 'projects');
          const project = getProjectTool(db, args, { today: getTodayDate() });
          if (!project) {
            return {
              content: [{ type: 'text', text: `Error: Project not found: ${args.id}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(project, null, 2) }],
          };
        }

        case 'mark_project_reviewed': {
          await ensureSyncForType(db, 'projects');
          const result = await markProjectReviewed(db, args, { today: getTodayDate() });
          if (!result.success) {
            return {
              content: [{ type: 'text', text: `Error: ${result.error}` }],
              isError: true,
            };
          }
          const text = `Marked "${result.project.title}" reviewed. Next review: ${result.next_review_date} (${result.frequency}).`
            + (result.warning ? `\n${result.warning}` : '');
          return { content: [{ type: 'text', text }] };
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
            const vaultPath = getAbsoluteVaultPath();
            const context = { db, vaultPath };

            // A read that timed out may still be syncing in the background
            // and holding source locks; this sync would skip those sources.
            await waitForReadSyncs(args.plugin_type);

            if (args.plugin_type) {
              await ensureSyncForType(db, args.plugin_type, { force: true, skipAutoTag: false });
            } else {
              await syncAllPlugins(context);
            }

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

        case 'get_context': {
          const [instructionsByType, liveContext] = await Promise.all([
            aiInstructionsByType(),
            args?.include_live === false ? Promise.resolve(null) : readLiveContext({ readOnly }),
          ]);
          return {
            content: [{ type: 'text', text: buildContextText({ instructionsByType, liveContext }) }],
          };
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
        await syncForRead(db, 'tasks');
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
        await syncForRead(db, 'tasks');
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
        await syncForRead(db, 'events');
        const { info, total, has_more, events } = listUpcomingEvents(db, { limit: 50 });

        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ ...info, total, has_more, events }, null, 2),
          }],
        };
      }

      if (uri === 'today://events/today') {
        await syncForRead(db, 'events');
        const { info, from, to, events } = listEventsForDays(db, {});

        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ ...info, from, to, events }, null, 2),
          }],
        };
      }

      if (uri === 'today://time-logs') {
        await syncForRead(db, 'time-logs');
        const today = getTodayDate();
        const logs = db.prepare(`
          SELECT id, start_time, end_time, duration_minutes, description, source
          FROM time_logs
          WHERE ${sqlLocalDate('start_time')} >= date(?, '-7 days')
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
        await syncForRead(db, 'diary');
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
        await syncForRead(db, 'tasks');
        await syncForRead(db, 'events');

        const today = getTodayDate();

        const tasks = db.prepare(`
          SELECT title, priority, due_date, metadata
          FROM tasks
          WHERE status = 'open'
            AND (due_date <= ? OR json_extract(metadata, '$.scheduled_date') <= ?)
          ORDER BY CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 ELSE 3 END
          LIMIT 20
        `).all(today, today);

        const { info: tzInfo, events } = listEventsForDays(db, {});

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

${timeZoneLine(tzInfo)}

## Today's Events
${events.length > 0 ? events.map(e => `- ${eventTimeLabel(e, tzInfo.user_timezone)}: ${e.title}${e.location ? ` @ ${e.location}` : ''}`).join('\n') : 'No events scheduled'}

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
        await syncForRead(db, 'tasks');

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
        await syncForRead(db, 'tasks');

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

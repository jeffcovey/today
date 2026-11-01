/**
 * The user's guidance for MCP callers: the same profile, top-level
 * instructions and per-source `ai_instructions` that `bin/today` gives its
 * own AI, so a remote client (claude.ai) works from the same context.
 *
 * It reaches the caller three ways, most reliable first:
 *   - tool descriptions: each tool carries its plugin type's description and
 *     the user's instructions for those sources (models always see these);
 *   - server instructions, sent at initialize: profile, time zone, top-level
 *     instructions, and a pointer to get_context;
 *   - the get_context tool: all of it plus live context-plugin output.
 *
 * The whole profile goes out: every key in [profile], plus the top-level
 * `location`. `[mcp] profile_fields`, when set, narrows it to the fields it
 * lists.
 */

import { schemas } from './plugin-schemas.js';
import { getFullConfig } from './config.js';
import { getConfiguredTimezone, getCurrentTimeISO, getTodayDate } from './date-utils.js';

const PROFILE_LABELS = {
  name: 'Name',
  location: 'Current location',
  home_location: 'Home',
  vocation: 'Vocation',
  wake_time: 'Wake time',
  bed_time: 'Bed time',
  wind_down_hours: 'Wind-down hours before bed',
  email: 'Email',
  birthdate: 'Birthdate',
};

// Plugin types that have their own MCP tools; the rest are reached through
// query_database, so their guidance goes on that tool.
const TOOL_TYPES = {
  tasks: ['list_tasks', 'create_task', 'complete_task'],
  events: ['list_events', 'create_event'],
  'time-logs': ['start_timer', 'stop_timer'],
  projects: ['list_projects', 'get_project', 'mark_project_reviewed'],
};

// MCP-specific notes that replace the CLI-oriented queryInstructions.
const MCP_NOTES = {
  events: "Event times in the events table are stored in UTC (ending in Z) unless they carry an offset or a start_timezone. Convert them to the user's time zone before presenting them as local times. Prefer list_events over reading times with query_database.",
};

function readConfig(config) {
  if (config) return config;
  try {
    return getFullConfig() || {};
  } catch {
    return {};
  }
}

/**
 * Which profile fields go out: the list in [mcp] profile_fields if it is set,
 * otherwise all of them, which is `name` first, then `location` (the
 * top-level key, where the user is now), then every other [profile] key in
 * the order the config lists them.
 */
export function getProfileFields(config) {
  const cfg = readConfig(config);
  const fields = cfg.mcp?.profile_fields;
  if (Array.isArray(fields)) {
    return fields.filter(f => typeof f === 'string' && f.trim()).map(f => f.trim());
  }
  const profile = cfg.profile && typeof cfg.profile === 'object' ? cfg.profile : {};
  const rest = Object.keys(profile).filter(k => k !== 'name' && k !== 'location');
  return ['name', 'location', ...rest];
}

// "favorite_foods" -> "Favorite foods", for keys without a label above.
function labelFor(key) {
  if (PROFILE_LABELS[key]) return PROFILE_LABELS[key];
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// TOML values as text: dates as written (smol-toml's dates print their
// original form through toISOString), lists joined, tables as JSON.
function formatValue(raw) {
  if (raw instanceof Date) return raw.toISOString();
  if (Array.isArray(raw)) return raw.map(formatValue).join(', ');
  if (raw && typeof raw === 'object') return JSON.stringify(raw);
  return String(raw).trim();
}

/**
 * The shared profile fields that have values. `location` is the top-level
 * key (where the user is now); the rest come from [profile]. Home is left
 * out when it is the same as the current location, as bin/today does.
 * @returns {Array<{key: string, label: string, value: string}>}
 */
export function getSharedProfile(config) {
  const cfg = readConfig(config);
  const profile = cfg.profile || {};
  const fields = getProfileFields(cfg);
  const out = [];
  for (const key of fields) {
    const raw = key === 'location' ? cfg.location : profile[key];
    if (raw === undefined || raw === null) continue;
    const value = formatValue(raw);
    if (value === '') continue;
    if (key === 'home_location' && cfg.location && value === String(cfg.location).trim()
        && fields.includes('location')) continue;
    out.push({ key, label: labelFor(key), value });
  }
  return out;
}

export function getTopLevelInstructions(config) {
  const text = readConfig(config).ai?.ai_instructions;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

/**
 * Guidance for one plugin type: its built-in description, the enabled
 * sources, and the user's ai_instructions for each source that has them.
 * @param {string} type
 * @param {Map} instructionsByType - from getAIInstructionsByType()
 */
export function typeGuidance(type, instructionsByType) {
  const data = instructionsByType?.get(type);
  const schema = schemas[type];
  if (!data || data.sources.length === 0) return null;

  const lines = [];
  if (schema?.ai?.description) lines.push(schema.ai.description.replace(/\s*\n\s*/g, ' ').trim());
  if (MCP_NOTES[type]) lines.push(MCP_NOTES[type]);
  if (schema?.table) lines.push(`Table: ${schema.table}. Sources: ${data.sources.join(', ')}.`);
  else lines.push(`Sources: ${data.sources.join(', ')}.`);
  if (data.instructions.length > 0) {
    lines.push("The user's instructions for these sources:");
    for (const { sourceId, text } of data.instructions) {
      lines.push(`From ${sourceId}:\n${text}`);
    }
  }
  return lines.join('\n');
}

/**
 * Append each tool's plugin guidance to its description. Types without a
 * tool of their own (health, email, …) go on query_database.
 * Mutates and returns `tools`.
 */
export function addGuidanceToTools(tools, instructionsByType) {
  if (!instructionsByType) return tools;
  const byName = new Map(tools.map(t => [t.name, t]));

  for (const [type, names] of Object.entries(TOOL_TYPES)) {
    const guidance = typeGuidance(type, instructionsByType);
    if (!guidance) continue;
    for (const name of names) {
      const tool = byName.get(name);
      if (tool) tool.description = `${tool.description}\n\n${guidance}`;
    }
  }

  const query = byName.get('query_database');
  if (query) {
    const sections = [];
    for (const type of instructionsByType.keys()) {
      // A type whose own tools are all hidden (time-logs on a read-only
      // connection) is read through this tool, so its guidance goes here.
      const ownTools = TOOL_TYPES[type];
      if ((ownTools && ownTools.some(name => byName.has(name))) || type === 'context' || !schemas[type]?.table) continue;
      const guidance = typeGuidance(type, instructionsByType);
      if (guidance) sections.push(`## ${schemas[type].ai?.name || type}\n${guidance}`);
    }
    if (sections.length > 0) {
      query.description = `${query.description}\n\nData reached through this tool:\n\n${sections.join('\n\n')}`;
    }
  }
  return tools;
}

/**
 * Server instructions, sent once at initialize. Built from config only
 * (synchronous), so a config edit applies to the next connection.
 */
export function buildServerInstructions(config) {
  const cfg = readConfig(config);
  const lines = [
    "Today is the user's personal system: tasks, calendar, time tracking, habits, mail, projects and more, kept in their vault.",
    'At the start of a conversation, call get_context for the current time, the user\'s profile, their instructions for every data source, and live context such as today\'s stage and plan. Each tool\'s description also carries the user\'s instructions for the sources it reads.',
    `The user's configured time zone is ${cfg.timezone || getConfiguredTimezone()}; they change it when traveling.`,
  ];
  const profile = getSharedProfile(cfg);
  if (profile.length > 0) {
    lines.push('', 'About the user:', ...profile.map(p => `- ${p.label}: ${p.value}`));
  }
  const top = getTopLevelInstructions(cfg);
  if (top) lines.push('', "The user's instructions:", top);
  return lines.join('\n');
}

/**
 * The get_context reply, as markdown in the shape of bin/today's
 * "Pre-Computed Context": time, profile, instructions, every enabled type,
 * then live context-plugin output when given.
 */
export function buildContextText({ config, instructionsByType, liveContext = null, now } = {}) {
  const cfg = readConfig(config);
  const tz = cfg.timezone || getConfiguredTimezone();
  const lines = [
    '# Context',
    '',
    `- Current time: ${now || getCurrentTimeISO(tz)} (${tz})`,
    `- Today: ${getTodayDate(tz)}`,
  ];

  const profile = getSharedProfile(cfg);
  if (profile.length > 0) {
    lines.push('', '## User profile', ...profile.map(p => `- ${p.label}: ${p.value}`));
  }

  const top = getTopLevelInstructions(cfg);
  if (top) lines.push('', "## User's instructions", top);

  if (instructionsByType) {
    const sections = [];
    for (const type of instructionsByType.keys()) {
      if (type === 'context') continue;
      const guidance = typeGuidance(type, instructionsByType);
      if (guidance) sections.push(`### ${schemas[type]?.ai?.name || type}\n${guidance}`);
    }
    const ctx = instructionsByType.get('context');
    if (ctx?.instructions?.length) {
      sections.push(`### Contextual information\nThe user's instructions:\n${ctx.instructions.map(i => `From ${i.sourceId}:\n${i.text}`).join('\n')}`);
    }
    if (sections.length > 0) lines.push('', '## Data sources', '', sections.join('\n\n'));
  }

  if (liveContext && liveContext.trim()) {
    lines.push('', '## Live context', '', liveContext.trim());
  }
  return lines.join('\n');
}

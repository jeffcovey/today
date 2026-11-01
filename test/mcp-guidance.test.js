/**
 * MCP callers get the profile fields the user allows, the top-level and
 * per-source ai_instructions, and plugin guidance on each tool.
 */

import {
  DEFAULT_PROFILE_FIELDS,
  getProfileFields,
  getSharedProfile,
  typeGuidance,
  addGuidanceToTools,
  buildServerInstructions,
  buildContextText,
} from '../src/mcp-guidance.js';

const config = {
  timezone: 'America/New_York',
  location: 'Lisbon, Portugal',
  profile: {
    name: 'Pat Example',
    email: 'pat@example.com',
    home_location: 'Springfield',
    vocation: 'Writer',
    wake_time: '06:00',
    bed_time: '22:00',
    birthdate: '1970-01-01',
  },
  ai: { ai_instructions: 'Start each day with a project.\n' },
};

function instructions() {
  return new Map([
    ['events', { sources: ['google-calendar/personal', 'public-calendars/trips'], instructions: [
      { sourceId: 'google-calendar/personal', text: 'My own appointments.' },
    ] }],
    ['tasks', { sources: ['markdown-tasks/local'], instructions: [] }],
    ['health', { sources: ['apple-health-auto-export/default'], instructions: [
      { sourceId: 'apple-health-auto-export/default', text: 'Check yesterday\'s steps.' },
    ] }],
    ['context', { sources: ['stages/default'], instructions: [
      { sourceId: 'stages/default', text: 'Respect the day\'s stage.' },
    ] }],
  ]);
}

describe('profile fields', () => {
  test('by default email and birthdate stay out', () => {
    expect(DEFAULT_PROFILE_FIELDS).not.toContain('email');
    expect(DEFAULT_PROFILE_FIELDS).not.toContain('birthdate');
    const shared = getSharedProfile(config);
    expect(shared.map(p => p.key)).toEqual(['name', 'location', 'home_location', 'vocation', 'wake_time', 'bed_time']);
    expect(JSON.stringify(shared)).not.toContain('pat@example.com');
    expect(JSON.stringify(shared)).not.toContain('1970-01-01');
  });

  test('[mcp] profile_fields chooses exactly what goes out', () => {
    const cfg = { ...config, mcp: { profile_fields: ['name', 'email'] } };
    expect(getProfileFields(cfg)).toEqual(['name', 'email']);
    expect(getSharedProfile(cfg)).toEqual([
      { key: 'name', label: 'Name', value: 'Pat Example' },
      { key: 'email', label: 'Email', value: 'pat@example.com' },
    ]);
    expect(getSharedProfile({ ...config, mcp: { profile_fields: [] } })).toEqual([]);
  });

  test('home is dropped when it is where the user already is', () => {
    const cfg = { ...config, location: 'Springfield' };
    expect(getSharedProfile(cfg).map(p => p.key)).not.toContain('home_location');
  });
});

describe('typeGuidance', () => {
  test('description, table, sources and the user\'s instructions by source', () => {
    const text = typeGuidance('events', instructions());
    expect(text).toContain('Table: events. Sources: google-calendar/personal, public-calendars/trips.');
    expect(text).toContain('stored in UTC');
    expect(text).toContain("The user's instructions for these sources:\nFrom google-calendar/personal:\nMy own appointments.");
    expect(text).not.toContain('bin/calendar');
  });

  test('a type with no enabled source gives nothing', () => {
    expect(typeGuidance('finance', instructions())).toBeNull();
  });
});

describe('addGuidanceToTools', () => {
  test('tools carry their type\'s guidance; types without a tool go on query_database', () => {
    const tools = [
      { name: 'list_events', description: 'List calendar events' },
      { name: 'list_tasks', description: 'List tasks' },
      { name: 'query_database', description: 'Run SQL' },
    ];
    addGuidanceToTools(tools, instructions());
    expect(tools[0].description).toMatch(/^List calendar events\n\n/);
    expect(tools[0].description).toContain('My own appointments.');
    expect(tools[1].description).toContain('Sources: markdown-tasks/local.');
    expect(tools[2].description).toContain('## Health Metrics');
    expect(tools[2].description).toContain("Check yesterday's steps.");
    expect(tools[2].description).not.toContain('My own appointments.');
  });

  test('without instructions the tools are left alone', () => {
    const tools = [{ name: 'list_tasks', description: 'List tasks' }];
    addGuidanceToTools(tools, null);
    expect(tools[0].description).toBe('List tasks');
  });
});

describe('server instructions and get_context', () => {
  test('server instructions carry the zone, the allowed profile and the top-level instructions', () => {
    const text = buildServerInstructions(config);
    expect(text).toContain('call get_context');
    expect(text).toContain('America/New_York');
    expect(text).toContain('- Name: Pat Example');
    expect(text).toContain('- Current location: Lisbon, Portugal');
    expect(text).toContain("The user's instructions:\nStart each day with a project.");
    expect(text).not.toContain('pat@example.com');
  });

  test('get_context has time, profile, instructions, every source and live context', () => {
    const text = buildContextText({
      config, instructionsByType: instructions(), liveContext: 'Today is a Back Stage day.\n', now: '2026-11-01T09:02:17-05:00',
    });
    expect(text).toContain('- Current time: 2026-11-01T09:02:17-05:00 (America/New_York)');
    expect(text).toContain('## User profile\n- Name: Pat Example');
    expect(text).toContain("## User's instructions\nStart each day with a project.");
    expect(text).toContain('### Calendar Events');
    expect(text).toContain('### Health Metrics');
    expect(text).toContain("Respect the day's stage.");
    expect(text).toContain('## Live context\n\nToday is a Back Stage day.');
    expect(text).not.toContain('1970-01-01');
  });
});

/**
 * The MCP project tools: listing (and the due-for-review rule bin/projects
 * review uses), one project's details, and marking a project reviewed.
 */

import { jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { getProjectsDueForReview, addDays, nextReviewDate } from '../src/projects.js';
import {
  listProjectsTool,
  getProjectTool,
  markProjectReviewed,
  PROJECT_TOOL_DEFINITIONS,
  PROJECT_WRITE_TOOLS,
} from '../src/mcp-projects.js';
import { WRITE_TOOLS } from '../src/mcp-server.js';

const TODAY = '2026-11-01';

function projectDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL, priority TEXT, topic TEXT, start_date TEXT, due_date TEXT,
      completed_at TEXT, progress INTEGER, review_frequency TEXT, last_reviewed TEXT,
      url TEXT, metadata TEXT
    );
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT);
  `);
  const insert = db.prepare(`INSERT INTO projects (id, source, title, status, priority, review_frequency, last_reviewed, metadata)
    VALUES (@id, @source, @title, @status, @priority, @review_frequency, @last_reviewed, @metadata)`);
  const row = (o) => insert.run({ source: 'markdown-projects/local', priority: 'medium', review_frequency: null, last_reviewed: null, metadata: null, ...o });

  row({ id: 'vault/projects/garden.md', title: 'Garden', status: 'active', review_frequency: 'weekly', last_reviewed: '2026-10-20' });
  row({ id: 'vault/projects/taxes.md', title: 'Taxes', status: 'active', review_frequency: 'monthly', last_reviewed: '2026-10-25' });
  row({ id: 'vault/projects/novel.md', title: 'Novel', status: 'planning', review_frequency: 'quarterly' });
  row({ id: 'vault/projects/garage.md', title: 'Garage sale', status: 'on_hold', review_frequency: 'daily', last_reviewed: '2026-01-01' });
  row({ id: 'vault/projects/move.md', title: 'Move', status: 'completed', review_frequency: 'weekly', last_reviewed: '2026-01-01' });
  row({
    id: 'vault/projects/app.md', title: 'App launch', status: 'active', priority: 'high',
    metadata: JSON.stringify({
      item_query: { table: 'tasks', title_field: 'title', status_field: 'status', status_open: 'open', status_closed: 'done', id_pattern: 'vault/projects/app.md:%' },
    }),
  });
  const task = db.prepare('INSERT INTO tasks VALUES (?, ?, ?)');
  task.run('vault/projects/app.md:1', 'Submit build', 'open');
  task.run('vault/projects/app.md:2', 'Write notes', 'open');
  task.run('vault/projects/app.md:3', 'Pick name', 'done');
  return db;
}

describe('due for review', () => {
  test('active or planning, overdue by their frequency, never-reviewed last', () => {
    const titles = getProjectsDueForReview(projectDb(), TODAY).map(p => p.title);
    // Taxes is 7 days into a monthly cycle; Garage sale is on hold; Move is done.
    expect(titles).toEqual(['Garden', 'Novel']);
  });

  test('list_projects with due_for_review says how many and when each is due', () => {
    const { summary, projects } = listProjectsTool(projectDb(), { due_for_review: true }, { today: TODAY });
    expect(summary).toBe('2 projects are due for review.');
    expect(projects[0]).toMatchObject({ title: 'Garden', days_since: 12, next_review: '2026-10-27', due_for_review: true });
    expect(projects[1]).toMatchObject({ title: 'Novel', next_review: TODAY, due_for_review: true });
  });

  test('next review dates are whole days whatever the time zone', () => {
    expect(addDays('2026-11-01', 7)).toBe('2026-11-08');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(nextReviewDate({ review_frequency: 'monthly', last_reviewed: '2026-10-25' }, TODAY)).toBe('2026-11-24');
    expect(nextReviewDate({ review_frequency: null }, TODAY)).toBeNull();
  });
});

describe('list_projects', () => {
  test('leaves out completed and archived projects unless asked', () => {
    const db = projectDb();
    expect(listProjectsTool(db, {}, { today: TODAY }).projects.map(p => p.title))
      .toEqual(['App launch', 'Garden', 'Taxes', 'Novel', 'Garage sale']);
    expect(listProjectsTool(db, { include_completed: true }, { today: TODAY }).projects).toHaveLength(6);
    expect(listProjectsTool(db, { status: 'completed' }, { today: TODAY }).projects.map(p => p.title)).toEqual(['Move']);
  });

  test('filters by review schedule and priority', () => {
    const db = projectDb();
    expect(listProjectsTool(db, { has_review: true }, { today: TODAY }).projects).toHaveLength(4);
    expect(listProjectsTool(db, { priority: 'high' }, { today: TODAY }).summary).toBe('1 project.');
  });
});

describe('get_project', () => {
  test('finds by part of the title and shows items without the raw metadata', () => {
    const project = getProjectTool(projectDb(), { id: 'launch' }, { today: TODAY });
    expect(project.title).toBe('App launch');
    expect(project.metadata).toBeUndefined();
    expect(project.item_counts).toEqual({ open: 2, closed: 1 });
    expect(project.open_items.map(i => i.title)).toEqual(['Submit build', 'Write notes']);
    expect(project.open_items_not_shown).toBe(0);
    expect(project.next_review).toBeNull();
  });

  test('is null when nothing matches', () => {
    expect(getProjectTool(projectDb(), { id: 'nothing like it' }, { today: TODAY })).toBeNull();
  });
});

describe('mark_project_reviewed', () => {
  test('sets the next review one period from today, keeping the frequency, then syncs', async () => {
    const write = jest.fn(async () => ({ success: true }));
    const sync = jest.fn(async () => ({ success: true }));
    const result = await markProjectReviewed(projectDb(), { id: 'Garden' }, { today: TODAY, write, sync });
    expect(result).toEqual({
      success: true,
      project: { id: 'vault/projects/garden.md', title: 'Garden' },
      next_review_date: '2026-11-08',
      frequency: 'weekly',
    });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'vault/projects/garden.md' }),
      { action: 'set-review-date', reviewDate: '2026-11-08', frequency: 'weekly' }
    );
    expect(sync).toHaveBeenCalledWith(expect.anything(), 'markdown-projects/local');
  });

  test('takes an explicit next review date', async () => {
    const write = jest.fn(async () => ({ success: true }));
    const result = await markProjectReviewed(projectDb(), { id: 'vault/projects/taxes.md', next_review_date: '2027-01-15' },
      { today: TODAY, write, sync: async () => ({ success: true }) });
    expect(result.next_review_date).toBe('2027-01-15');
    expect(write.mock.calls[0][1]).toEqual({ action: 'set-review-date', reviewDate: '2027-01-15', frequency: 'monthly' });
  });

  test('refuses an ambiguous match rather than guess which project', async () => {
    const write = jest.fn();
    const result = await markProjectReviewed(projectDb(), { id: 'Gar' }, { today: TODAY, write });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/matches 2 projects/);
    expect(write).not.toHaveBeenCalled();
  });

  test('needs a frequency for a project without one', async () => {
    const write = jest.fn(async () => ({ success: true }));
    const db = projectDb();
    const refused = await markProjectReviewed(db, { id: 'App launch' }, { today: TODAY, write });
    expect(refused.error).toMatch(/has no review frequency/);
    const ok = await markProjectReviewed(db, { id: 'App launch', frequency: 'monthly' },
      { today: TODAY, write, sync: async () => ({ success: true }) });
    expect(ok).toMatchObject({ success: true, next_review_date: '2026-12-01', frequency: 'monthly' });
  });

  test('reports the plugin error and a sync that lags behind', async () => {
    const failed = await markProjectReviewed(projectDb(), { id: 'Garden' },
      { today: TODAY, write: async () => ({ success: false, error: 'file locked' }) });
    expect(failed).toEqual({ success: false, error: 'file locked' });

    const lagging = await markProjectReviewed(projectDb(), { id: 'Garden' },
      { today: TODAY, write: async () => ({ success: true }), sync: async () => ({ success: false, message: 'busy' }) });
    expect(lagging.success).toBe(true);
    expect(lagging.warning).toMatch(/busy/);
  });

  test('is a write tool, hidden on read-only connections', () => {
    expect(PROJECT_WRITE_TOOLS).toEqual(['mark_project_reviewed']);
    expect(WRITE_TOOLS.has('mark_project_reviewed')).toBe(true);
    expect(PROJECT_TOOL_DEFINITIONS.map(t => t.name)).toEqual(['list_projects', 'get_project', 'mark_project_reviewed']);
  });
});

describe('markdown-projects set-review-date', () => {
  test('records last_reviewed as the same day west of UTC', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-review-'));
    try {
      fs.mkdirSync(path.join(root, 'vault/projects'), { recursive: true });
      const file = path.join(root, 'vault/projects/x.md');
      fs.writeFileSync(file, '---\ntitle: X\nreview_frequency: weekly\nlast_reviewed: 2026-10-01\n---\nbody\n');
      const out = execFileSync(process.execPath, [path.resolve('plugins/markdown-projects/write.js')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TZ: 'America/New_York',
          PROJECT_ROOT: root,
          PLUGIN_WRITE_ARGS: JSON.stringify({ action: 'set-review-date', projectId: 'vault/projects/x.md', reviewDate: '2026-11-08' }),
        },
      });
      expect(JSON.parse(out).updated.lastReviewedDate).toBe('2026-11-01');
      expect(fs.readFileSync(file, 'utf8')).toMatch(/last_reviewed: "?2026-11-01"?/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

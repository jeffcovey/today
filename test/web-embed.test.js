import path from 'path';
import fs from 'fs';
import { jest } from '@jest/globals';
import { startServer, PASSWORD } from './helpers/a11y-harness.js';

/**
 * A page rendered with ?embed is what the TRMNL display polls, and TRMNL
 * refuses a polled page over 100 KB. On a day with 121 tasks completed, the
 * tasks page's embed came to 154 KB, almost all of it per-task markup only
 * the page's own script uses (ids, file and line, the link to the task page).
 *
 * These start the real web server against a vault with one tasks query and
 * enough done tasks to reproduce that day, then compare the embed with the
 * full page.
 */

jest.setTimeout(120_000);

const TRMNL_LIMIT_BYTES = 100_000;
const DONE_TASKS = 150;
const auth = { headers: { Authorization: `Bearer ${PASSWORD}` } };

let server;

beforeAll(async () => {
  server = await startServer();

  fs.mkdirSync(path.join(server.vaultDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(server.vaultDir, 'tasks', 'embed-check.md'), [
    '# Embed check',
    '',
    '```tasks',
    'done today',
    'sort by done reverse',
    '```',
    ''
  ].join('\n'));

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(path.join(server.workDir, '.data', 'today.db'));
  try {
    const insert = db.prepare(
      'INSERT INTO tasks (id, source, title, status, priority, completed_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const now = new Date().toISOString();
    for (let line = 1; line <= DONE_TASKS; line++) {
      insert.run(`markdown-tasks/local:vault/tasks/tasks-archive.md:${line}`, 'markdown-tasks/local',
        `Finished chore number ${line}`, 'completed', 'medium', now,
        JSON.stringify({ file_path: 'vault/tasks/tasks-archive.md', line_number: line }));
    }
  } finally {
    db.close();
  }
});

afterAll(async () => {
  await server?.stop();
});

async function page(query = '') {
  const response = await fetch(`${server.baseUrl}/tasks/embed-check.md${query}`, auth);
  expect(response.status).toBe(200);
  return response.text();
}

describe('embedded task lists', () => {
  test('keep every task, its checkbox and its priority', async () => {
    const html = await page('?embed&zoom=125');
    const items = html.match(/<li class="task-done"><input type="checkbox" checked class="task-checkbox"> /g) || [];
    expect(items).toHaveLength(DONE_TASKS);
    expect(html).toContain('Finished chore number 1 ');
    expect(html).toContain(`Finished chore number ${DONE_TASKS} `);
    expect(html).toContain('aria-label="Medium priority"'); // the priority marker, as an icon
  });

  test('leave out what only the full page script uses', async () => {
    const html = await page('?embed');
    expect(html).not.toContain('data-task-id');
    expect(html).not.toContain('data-file');
    expect(html).not.toContain('href="/task/');
  });

  test('stay well under TRMNL\'s polling limit', async () => {
    const embed = await page('?embed');
    expect(Buffer.byteLength(embed)).toBeLessThan(TRMNL_LIMIT_BYTES / 2);
  });

  test('the full page keeps its links and ids', async () => {
    // The full page loads its query blocks afterwards, from their own URL
    const shell = await page();
    const src = shell.match(/data-deferred-src="([^"]+)"/)[1].replace(/&amp;/g, '&');
    const response = await fetch(`${server.baseUrl}${src}`, auth);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-task-id="markdown-tasks/local:vault/tasks/tasks-archive.md:1"');
    expect(html).toContain('href="/task/markdown-tasks/local:vault/tasks/tasks-archive.md:1"');
  });
});

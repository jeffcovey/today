// The Git page's Pull alert (the inline script in web-server.js).
import fs from 'fs';

const source = fs.readFileSync(new URL('../src/web-server.js', import.meta.url), 'utf8');
const start = source.indexOf('function pullResultMessage(data)');
const end = source.indexOf('async function gitPull()', start);
// The script sits in a template literal, so `\\n` in the source is `\n` in the page.
const fnSource = source.slice(start, end).replace(/\\\\/g, '\\');
const pullResultMessage = new Function(`${fnSource}; return pullResultMessage;`)();

test('a failed pull still lists the files that were set aside', () => {
  const message = pullResultMessage({ error: 'Pull failed', setAside: ['plans/new.md.local-2026'] });
  expect(message).toMatch(/^Pull failed/);
  expect(message).toContain('plans/new.md.local-2026');
});

test('a failed pull with nothing set aside shows just the error', () => {
  expect(pullResultMessage({ error: 'Pull failed', setAside: [] })).toBe('Pull failed');
});

test('a successful pull lists set-aside and resolved files', () => {
  const message = pullResultMessage({ ok: true, stashed: true, resolved: ['diary.md'], setAside: ['a.md.local-1'] });
  expect(message).toMatch(/^Pull succeeded/);
  expect(message).toContain('diary.md');
  expect(message).toContain('a.md.local-1');
  expect(message).toContain('\n');
});

test('a plain successful pull needs no alert', () => {
  expect(pullResultMessage({ ok: true })).toBe('');
});

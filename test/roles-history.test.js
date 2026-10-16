import fs from 'fs';
import os from 'os';
import path from 'path';
import { collectRoleHistory, countUserReplies, formatRoleHistory } from '../plugins/roles/role-history.js';
import { getDailyPlanRelativePath } from '../src/plan-utils.js';

function block(role, body) {
  return `<!-- ROLE:${role}:START -->\n## 🤖 ${role}\n\n${body}\n<!-- ROLE:${role}:END -->\n`;
}

describe('collectRoleHistory', () => {
  let vaultPath;

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-history-'));
    fs.mkdirSync(path.join(vaultPath, 'plans'));
    const write = (date, text) => fs.writeFileSync(path.join(vaultPath, getDailyPlanRelativePath(date)), text);

    write('2026-10-01', block('secretary', '### 08:00\n\nToo old to matter.'));
    write('2026-10-12', '# Daily Plan - Monday, October 12, 2026\n\n## 📋 Top Priorities\n\n- [ ] Walk!\n\n'
      + block('chief-of-staff', '### 16:07\n\n**Decide tonight.**')
      + '\n'
      + block('secretary', '### 16:07\n\n**Show tomorrow.**\n\n- [x] → Jeff: decide\n\n-> secretary: I sat zazen. Not going.\n'));
    write('2026-10-13', block('secretary', '### 04:07\n\n**Birthday Friday.**\n\n-> secretary: Drop this.\n')
      + '\n'
      + block('cpa', '### 04:08\n\nBooks balanced.'));
    // 2026-10-14 has no plan file at all.
    write('2026-10-15', block('chief-of-staff', '### 04:09\n\nDispatch: nothing due.'));
  });

  afterEach(() => {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  });

  test('returns the wanted roles only, oldest first, within the window', () => {
    const history = collectRoleHistory({ vaultPath, roles: ['secretary', 'chief-of-staff'], days: 14, today: '2026-10-15' });

    expect(history.map((h) => `${h.date} ${h.role}`)).toEqual([
      '2026-10-12 chief-of-staff',
      '2026-10-12 secretary',
      '2026-10-13 secretary',
      '2026-10-15 chief-of-staff'
    ]);
    expect(history.some((h) => h.content.includes('Too old'))).toBe(false);
    expect(history.some((h) => h.content.includes('Books balanced'))).toBe(false);
    expect(history.some((h) => h.content.includes('Top Priorities'))).toBe(false);
  });

  test('keeps the user\'s reply lines verbatim and drops the display heading', () => {
    const history = collectRoleHistory({ vaultPath, roles: ['secretary'], days: 14, today: '2026-10-15' });

    expect(history[0].content).toContain('-> secretary: I sat zazen. Not going.');
    expect(history[1].content).toContain('-> secretary: Drop this.');
    expect(history[0].content).not.toContain('## 🤖');
    expect(countUserReplies(history)).toBe(2);
  });

  test('the window ends at today and counts days inclusively', () => {
    const history = collectRoleHistory({ vaultPath, roles: ['secretary'], days: 3, today: '2026-10-15' });
    expect(history.map((h) => h.date)).toEqual(['2026-10-13']);
  });
});

describe('formatRoleHistory', () => {
  test('states the precedence rule, prints blocks verbatim, and counts replies', () => {
    const history = [
      { date: '2026-10-12', role: 'chief-of-staff', content: '### 16:07\n\n**Decide tonight.**' },
      { date: '2026-10-13', role: 'secretary', content: '### 04:07\n\n-> secretary: Drop this.' }
    ];
    const text = formatRoleHistory(history, { role: 'secretary', chief: 'chief-of-staff', days: 14, today: '2026-10-15' });

    expect(text).toContain('secretary and chief-of-staff, 2026-10-02 to 2026-10-15 (14 days)');
    expect(text).toContain('the user\'s "->" reply lines, then chief-of-staff, then secretary');
    expect(text).toContain('## 2026-10-12 — chief-of-staff');
    expect(text).toContain('## 2026-10-13 — secretary');
    expect(text).toContain('-> secretary: Drop this.');
    expect(text).toContain('2 blocks, 1 reply lines from the user.');
  });

  test('says so when there is nothing in the window', () => {
    const text = formatRoleHistory([], { role: 'cpa', chief: null, days: 7, today: '2026-10-15' });
    expect(text).toContain('Role blocks for cpa, 2026-10-09 to 2026-10-15 (7 days)');
    expect(text).toContain('(no blocks in this period)');
  });
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildLedger,
  checkQuiet,
  chooseTargetIndex,
  inWindow,
  insertSorted,
  ledgerExpired,
  listTaskFamily,
  nightlyWindow,
  planSortedInsert,
  repairFromLedger,
  taskKey,
  windowNightKey
} from '../src/task-files.js';
import { nightlyDecision } from '../src/task-nightly.js';

const t = title => `- [ ] ${title}`;

describe('sorted insertion', () => {
  test('insertSorted places a line case-insensitively', () => {
    expect(insertSorted([t('apple'), t('Cherry')], t('banana'))).toEqual([t('apple'), t('banana'), t('Cherry')]);
    expect(insertSorted([t('apple')], t('zebra'))).toEqual([t('apple'), t('zebra')]);
  });

  test('chooseTargetIndex picks the file whose range covers the line', () => {
    const files = [[t('Alpha'), t('Bravo')], [t('Delta'), t('Echo')], [t('Kilo')]];
    expect(chooseTargetIndex(files, t('Aardvark'))).toBe(0);
    expect(chooseTargetIndex(files, t('Charlie'))).toBe(0);
    expect(chooseTargetIndex(files, t('Foxtrot'))).toBe(1);
    expect(chooseTargetIndex(files, t('Zulu'))).toBe(2);
    expect(chooseTargetIndex([[], [t('Mike')]], t('Alpha'))).toBe(0);
  });

  describe('on disk', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-files-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('listTaskFamily orders numbered files numerically', () => {
      for (const name of ['tasks.md', 'tasks-10.md', 'tasks-2.md', 'tasks-1.md', 'tasks-archive.md']) {
        fs.writeFileSync(path.join(dir, name), '');
      }
      expect(listTaskFamily(path.join(dir, 'tasks.md')).map(p => path.basename(p)))
        .toEqual(['tasks.md', 'tasks-1.md', 'tasks-2.md', 'tasks-10.md']);
    });

    test('planSortedInsert touches only the files that gain a line and can skip existing lines', () => {
      fs.writeFileSync(path.join(dir, 'tasks.md'), `${t('Alpha')}\n${t('Bravo')}\n`);
      fs.writeFileSync(path.join(dir, 'tasks-1.md'), `${t('Mike')}\n${t('Zulu')}\n`);
      const plan = planSortedInsert(path.join(dir, 'tasks.md'), [t('November'), t('Bravo')], { skipExisting: true });
      expect(plan.map(p => path.basename(p.path))).toEqual(['tasks-1.md']);
      expect(plan[0].lines).toEqual([t('Mike'), t('November'), t('Zulu')]);
      expect(plan[0].original).toBe(`${t('Mike')}\n${t('Zulu')}\n`);
    });
  });
});

describe('taskKey', () => {
  test('ignores priority, dates and tags', () => {
    expect(taskKey('- [ ] Fix the gate 🔼 ➕ 2026-11-15 #stage/back-stage ⏳ 2026-11-16'))
      .toBe(taskKey('- [ ] Fix the gate ➕ 2026-11-14'));
    expect(taskKey('- [x] Fix the gate ✅ 2026-11-15')).toBe('fix the gate');
  });
});

describe('repairFromLedger', () => {
  // Today's failure: a rebalance moved A–C tasks into tasks.md and newer
  // tasks out of it; a file sync then brought back the old tasks.md, which
  // also had a task the user added on another device.
  const oldMain = [t('Delta old'), t('Mike new'), t('Zulu new')];
  const oldOne = [t('Alpha'), t('Bravo'), t('Charlie')];
  const newMain = [t('Alpha'), t('Bravo'), t('Charlie')];
  const newOne = [t('Delta old'), t('Mike new'), t('Zulu new')];
  const ledger = buildLedger({
    before: { 'tasks.md': oldMain, 'tasks-1.md': oldOne },
    after: { 'tasks.md': newMain, 'tasks-1.md': newOne },
    archiveLength: 0
  });

  test('restores what the reverted file lost and drops the duplicates it brought back', () => {
    const reverted = [...oldMain, t('Added elsewhere 🔼')];
    const result = repairFromLedger(ledger, [
      { name: 'tasks.md', lines: reverted },
      { name: 'tasks-1.md', lines: newOne }
    ]);
    expect(result.removed.sort()).toEqual([t('Delta old'), t('Mike new'), t('Zulu new')].sort());
    expect(result.restored).toEqual([t('Alpha'), t('Bravo'), t('Charlie')]);
    expect(result.files['tasks.md']).toEqual([t('Added elsewhere 🔼'), t('Alpha'), t('Bravo'), t('Charlie')].sort());
    expect(result.files['tasks-1.md']).toBeUndefined();
  });

  test('matches a reverted line even when its metadata differs', () => {
    const reverted = [t('Delta old ➕ 2026-11-01'), t('Mike new'), t('Zulu new')];
    const result = repairFromLedger(ledger, [
      { name: 'tasks.md', lines: reverted },
      { name: 'tasks-1.md', lines: newOne }
    ]);
    expect(result.removed).toContain(t('Delta old ➕ 2026-11-01'));
    expect(result.restored).toHaveLength(3);
  });

  test('is a no-op once repaired', () => {
    const first = repairFromLedger(ledger, [
      { name: 'tasks.md', lines: oldMain },
      { name: 'tasks-1.md', lines: newOne }
    ]);
    const second = repairFromLedger(ledger, [
      { name: 'tasks.md', lines: first.files['tasks.md'] },
      { name: 'tasks-1.md', lines: newOne }
    ]);
    expect(second).toEqual({ files: {}, restored: [], removed: [] });
  });

  test('leaves a deliberate deletion alone', () => {
    const result = repairFromLedger(ledger, [
      { name: 'tasks.md', lines: [t('Alpha'), t('Charlie')] },
      { name: 'tasks-1.md', lines: newOne }
    ]);
    expect(result).toEqual({ files: {}, restored: [], removed: [] });
  });

  test('does not bring back a lost task that was completed and archived', () => {
    const result = repairFromLedger(
      ledger,
      [{ name: 'tasks.md', lines: oldMain }, { name: 'tasks-1.md', lines: newOne }],
      ['- [x] Bravo ✅ 2026-11-15']
    );
    expect(result.restored).toEqual([t('Alpha'), t('Charlie')]);
  });

  test('reduces exact duplicate open lines to one', () => {
    const result = repairFromLedger(buildLedger({ before: {}, after: {} }), [
      { name: 'tasks.md', lines: [t('Alpha'), t('Alpha')] },
      { name: 'tasks-1.md', lines: [t('Alpha'), t('Mike')] }
    ]);
    expect(result.files).toEqual({ 'tasks.md': [t('Alpha')], 'tasks-1.md': [t('Mike')] });
    expect(result.removed).toEqual([t('Alpha'), t('Alpha')]);
  });

  test('ledgers expire after a day', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    expect(ledgerExpired({ created_at: '2026-11-15T13:00:00Z' }, now)).toBe(false);
    expect(ledgerExpired({ created_at: '2026-11-15T11:00:00Z' }, now)).toBe(true);
  });
});

describe('checkQuiet', () => {
  let dir;
  const now = Date.now();
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-quiet-'));
    fs.writeFileSync(path.join(dir, 'tasks.md'), t('Alpha'));
    const old = (now - 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(dir, 'tasks.md'), old, old);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('quiet when nothing changed recently', () => {
    expect(checkQuiet(dir, { now })).toEqual({ quiet: true });
  });

  test('not quiet while a Unison temp file is present', () => {
    fs.writeFileSync(path.join(dir, '.unison.tasks.md.abc.unison.tmp'), '');
    expect(checkQuiet(dir, { now }).quiet).toBe(false);
  });

  test('not quiet when a task file just changed', () => {
    fs.writeFileSync(path.join(dir, 'tasks-1.md'), t('Mike'));
    expect(checkQuiet(dir, { now: Date.now() }).reason).toMatch(/tasks-1\.md changed/);
  });
});

describe('nightly window', () => {
  test('starts halfway through the sleep hours and ends at wake time', () => {
    expect(nightlyWindow({ bedTime: '21:30', wakeTime: '05:30' })).toEqual({ start: 90, end: 330 });
    expect(nightlyWindow({ bedTime: '20:00', wakeTime: '02:00' })).toEqual({ start: 23 * 60, end: 120 });
    expect(nightlyWindow({ bedTime: '01:00', wakeTime: '09:00' })).toEqual({ start: 5 * 60, end: 9 * 60 });
  });

  test('falls back to 03:00–06:00 without usable sleep hours', () => {
    expect(nightlyWindow({})).toEqual({ start: 180, end: 360 });
    expect(nightlyWindow({ bedTime: 'late', wakeTime: '05:30' })).toEqual({ start: 180, end: 360 });
    expect(nightlyWindow({ bedTime: '05:30', wakeTime: '05:30' })).toEqual({ start: 180, end: 360 });
  });

  test('inWindow handles windows that cross midnight', () => {
    expect(inWindow(23 * 60 + 30, { start: 23 * 60, end: 120 })).toBe(true);
    expect(inWindow(60, { start: 23 * 60, end: 120 })).toBe(true);
    expect(inWindow(180, { start: 23 * 60, end: 120 })).toBe(false);
  });

  test('a window crossing midnight counts as the night it opened', () => {
    const window = { start: 23 * 60, end: 120 };
    expect(windowNightKey(new Date('2026-11-16T05:30:00Z'), 'America/New_York', window)).toBe('2026-11-15');
    expect(windowNightKey(new Date('2026-11-16T04:30:00Z'), 'America/New_York', window)).toBe('2026-11-15');
  });

  test('nightlyDecision uses the configured time zone and runs once a night', () => {
    const profile = { bed_time: '21:30', wake_time: '05:30' };
    const timeZone = 'America/New_York';
    const at = iso => nightlyDecision({ now: new Date(iso), timeZone, profile, sourceName: 'local' });

    expect(at('2026-11-16T06:00:00Z').due).toBe(false); // 01:00 Eastern
    expect(at('2026-11-16T06:30:00Z')).toMatchObject({ due: true, night: '2026-11-16' }); // 01:30
    expect(at('2026-11-16T10:30:00Z').due).toBe(false); // 05:30, wake time
    expect(nightlyDecision({
      now: new Date('2026-11-16T07:00:00Z'), timeZone, profile, sourceName: 'local',
      state: { sources: { local: '2026-11-16' } }
    })).toMatchObject({ due: false, reason: 'already ran tonight' });
    expect(nightlyDecision({
      now: new Date('2026-11-16T12:00:00Z'), timeZone, profile, sourceName: 'local', force: true
    }).due).toBe(true);
  });
});

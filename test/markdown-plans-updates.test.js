import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { updateTomorrowPlan } from '../plugins/markdown-plans/plan-updates.js';

describe('updateTomorrowPlan', () => {
  let filePath;

  beforeEach(() => {
    filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tomorrow-plan-')), 'plan.md');
    fs.writeFileSync(filePath, [
      '<!-- TODAY_FOCUS: Day theme and focus area -->',
      "## 🎯 Today's Focus",
      '<!-- /TODAY_FOCUS -->',
      '',
      '<!-- TOP_PRIORITIES: Auto-generated from database -->',
      '## 📋 Top Priorities',
      '<!-- /TOP_PRIORITIES -->'
    ].join('\n'));
  });

  afterEach(() => {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  test('returns false when the guarded write is skipped', () => {
    const rewrite = jest.fn(() => false);
    expect(updateTomorrowPlan(filePath, { focus: 'Rest' }, rewrite)).toBe(false);
    expect(rewrite).toHaveBeenCalledTimes(1);
  });

  test('returns true only when the update is persisted', () => {
    const rewrite = (_file, transform) => {
      const original = fs.readFileSync(filePath, 'utf8');
      const updated = transform(original);
      if (updated === null) return false;
      fs.writeFileSync(filePath, updated);
      return true;
    };
    expect(updateTomorrowPlan(filePath, { focus: 'Rest' }, rewrite)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('\nRest\n');
  });
});

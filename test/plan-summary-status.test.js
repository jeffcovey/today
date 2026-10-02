import { getPlanStatusBadge } from '../src/plan-summary-status.js';

describe('plan summary status badges', () => {
  test('renders explicit badges for blank, committed and uncommitted states', () => {
    expect(getPlanStatusBadge('blank')).toContain('>Blank</span>');
    expect(getPlanStatusBadge('committed')).toContain('bg-success status-badge">Committed</span>');
    expect(getPlanStatusBadge('uncommitted')).toContain('>Not committed</span>');
  });

  test('leaves unknown statuses without a label', () => {
    expect(getPlanStatusBadge(null)).toBe('<span class="status-badge"></span>');
  });
});

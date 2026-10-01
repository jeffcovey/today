export const PLAN_STATUS_BADGES = Object.freeze({
  blank: '<span class="badge bg-warning text-dark status-badge">Blank</span>',
  committed: '<span class="badge bg-success status-badge">Committed</span>',
  uncommitted: '<span class="badge bg-info text-dark status-badge">Not committed</span>',
});

export function getPlanStatusBadge(status) {
  return PLAN_STATUS_BADGES[status] || '<span class="status-badge"></span>';
}

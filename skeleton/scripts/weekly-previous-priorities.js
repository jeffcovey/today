// Weekly Previous Priorities Widget
// Shows the week_priorities from the previous week's review file
// Usage: await dv.view("scripts/weekly-previous-priorities", { weekNum: page.week_number, startDate: page.start_date })

const weekNum = input.weekNum;
const startDate = new Date(input.startDate);

// Calculate previous week number and date
const prevWeekNum = weekNum - 1;
const prevStartDate = new Date(startDate);
prevStartDate.setDate(prevStartDate.getDate() - 7);

// Build file path for previous week
const y = prevStartDate.getFullYear();
const q = Math.ceil((prevStartDate.getMonth() + 1) / 3);
const m = String(prevStartDate.getMonth() + 1).padStart(2, '0');
const prevFile = `plans/${y}_Q${q}_${m}_W${prevWeekNum}_00`;

const prevPage = dv.page(prevFile);

if (prevPage && prevPage.week_priorities) {
  const container = dv.el('div', '', {
    attr: { style: 'background: var(--background-secondary); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; border-left: 4px solid var(--color-purple);' }
  });

  dv.el('div', 'Last week\'s priorities:', {
    container,
    attr: { style: 'font-size: 0.85em; color: var(--text-muted); margin-bottom: 8px;' }
  });

  dv.el('div', prevPage.week_priorities, { container });
} else {
  dv.paragraph('*No priorities recorded for the previous week.*');
}

// Weekly Daily Links Widget
// Generates links to each day's plan file
// Usage: await dv.view("scripts/weekly-daily-links", { startDate: page.start_date, weekNum: page.week_number })

const startDate = new Date(input.startDate);
const weekNum = input.weekNum;

const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

for (let i = 0; i < 7; i++) {
  const d = new Date(startDate);
  d.setDate(d.getDate() + i);
  const y = d.getFullYear();
  const q = Math.ceil((d.getMonth() + 1) / 3);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const file = `${y}_Q${q}_${m}_W${weekNum}_${day}`;
  const dateStr = `${monthNames[d.getMonth()]} ${d.getDate()}`;

  const dailyPage = dv.page(`plans/${file}`);
  const summary = dailyPage?.daily_summary || '';

  const container = dv.el('div', '', { cls: 'daily-link-item' });
  const link = dv.el('strong', '', { container });
  dv.el('a', `${dayNames[i]} ${dateStr}`, {
    container: link,
    attr: { href: file, class: 'internal-link' }
  });

  if (summary) {
    dv.el('p', summary, { container, cls: 'daily-summary' });
  }
}

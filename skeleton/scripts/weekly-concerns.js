// Weekly Concerns Widget
// Displays concern notes from vault/notes/concerns/ that fall within the week
// Usage: await dv.view("scripts/weekly-concerns", { startDate: page.start_date })

const startDate = new Date(input.startDate);
const endDate = new Date(startDate);
endDate.setDate(endDate.getDate() + 6);
endDate.setHours(23, 59, 59, 999);

// Parse date from filename like "2025-11-26-100000-UTC-concerns.md"
function parseDateFromFilename(filename) {
  const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(match[1], parseInt(match[2]) - 1, match[3]);
  }
  return null;
}

// Get all concern files
const concernFiles = dv.pages('"notes/concerns"')
  .where(p => {
    const fileDate = parseDateFromFilename(p.file.name);
    if (!fileDate) return false;
    return fileDate >= startDate && fileDate <= endDate;
  })
  .sort(p => p.file.name, 'asc');

if (concernFiles.length === 0) {
  dv.paragraph('*No concerns recorded this week.*');
} else {
  for (const file of concernFiles) {
    const content = await dv.io.load(file.file.path);
    const lines = content.split('\n');
    const dateHeader = lines[0].trim();
    const body = lines.slice(2).join('\n').trim();

    // Format as a styled card with warning color
    const container = dv.el('div', '', {
      attr: { style: 'background: var(--background-secondary); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; border-left: 4px solid var(--color-orange);' }
    });
    dv.el('div', dateHeader, {
      container,
      attr: { style: 'font-size: 0.85em; color: var(--text-muted); margin-bottom: 8px;' }
    });
    const bodyEl = dv.el('div', '', { container });
    bodyEl.innerHTML = body.replace(/^- /gm, '').replace(/\n/g, '<br>');
  }
}

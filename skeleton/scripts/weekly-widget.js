// Plan Widget - Consolidated Dataview widgets for plan files
//
// Usage:
//   await dv.view("scripts/weekly-widget", { type: "navigation" })
//   await dv.view("scripts/weekly-widget", { type: "daily-links", startDate: page.start_date, weekNum: page.week_number })
//   await dv.view("scripts/weekly-widget", { type: "notes", startDate: page.start_date, folder: "progress", color: "green" })
//   await dv.view("scripts/weekly-widget", { type: "previous-priorities", startDate: page.start_date, weekNum: page.week_number })
//   await dv.view("scripts/weekly-widget", { type: "projects", startDate: page.start_date })

const type = input?.type || 'unknown';

// ============================================================================
// Type: navigation - Dynamic prev/up/next navigation links
// ============================================================================
if (type === 'navigation') {
  const currentFile = dv.current().file.name;

  // Parse plan filename to extract components
  function parsePlanFilename(filename) {
    // Daily: YYYY_Q#_MM_W##_DD
    const dailyMatch = filename.match(/^(\d{4})_Q(\d+)_(\d{2})_W(\d+)_(\d{2})$/);
    if (dailyMatch) {
      return {
        year: parseInt(dailyMatch[1]),
        quarter: parseInt(dailyMatch[2]),
        month: parseInt(dailyMatch[3]),
        week: parseInt(dailyMatch[4]),
        day: parseInt(dailyMatch[5]),
        type: 'daily'
      };
    }
    // Weekly: YYYY_Q#_MM_W##_00
    const weeklyMatch = filename.match(/^(\d{4})_Q(\d+)_(\d{2})_W(\d+)_00$/);
    if (weeklyMatch) {
      return {
        year: parseInt(weeklyMatch[1]),
        quarter: parseInt(weeklyMatch[2]),
        month: parseInt(weeklyMatch[3]),
        week: parseInt(weeklyMatch[4]),
        day: 0,
        type: 'weekly'
      };
    }
    // Monthly: YYYY_Q#_MM_00
    const monthlyMatch = filename.match(/^(\d{4})_Q(\d+)_(\d{2})_00$/);
    if (monthlyMatch) {
      return {
        year: parseInt(monthlyMatch[1]),
        quarter: parseInt(monthlyMatch[2]),
        month: parseInt(monthlyMatch[3]),
        week: 0,
        day: 0,
        type: 'monthly'
      };
    }
    // Quarterly: YYYY_Q#_00
    const quarterlyMatch = filename.match(/^(\d{4})_Q(\d+)_00$/);
    if (quarterlyMatch) {
      return {
        year: parseInt(quarterlyMatch[1]),
        quarter: parseInt(quarterlyMatch[2]),
        month: 0,
        week: 0,
        day: 0,
        type: 'quarterly'
      };
    }
    // Yearly: YYYY_00
    const yearlyMatch = filename.match(/^(\d{4})_00$/);
    if (yearlyMatch) {
      return {
        year: parseInt(yearlyMatch[1]),
        quarter: 0,
        month: 0,
        week: 0,
        day: 0,
        type: 'yearly'
      };
    }
    return null;
  }

  // Get parent plan filename (up the hierarchy)
  function getParentFilename(filename) {
    // Weekly → Monthly
    const weeklyMatch = filename.match(/^(\d{4}_Q\d+_\d{2})_W\d+_00$/);
    if (weeklyMatch) return `${weeklyMatch[1]}_00`;

    // Daily → Weekly
    const dailyMatch = filename.match(/^(\d{4}_Q\d+_\d{2}_W\d+)_\d{2}$/);
    if (dailyMatch) return `${dailyMatch[1]}_00`;

    // Monthly → Quarterly
    const monthlyMatch = filename.match(/^(\d{4}_Q\d+)_\d{2}_00$/);
    if (monthlyMatch) return `${monthlyMatch[1]}_00`;

    // Quarterly → Yearly
    const quarterlyMatch = filename.match(/^(\d{4})_Q\d+_00$/);
    if (quarterlyMatch) return `${quarterlyMatch[1]}_00`;

    return null;
  }

  // Get all plan files sorted chronologically
  const step1 = dv.pages('"plans"').where(p => /^\d{4}_/.test(p.file.name));
  const step2 = step1.map(p => ({ name: p.file.name, parsed: parsePlanFilename(p.file.name) }));
  const step3 = step2.filter(f => f.parsed !== null);

  // Convert to regular array for sorting (Dataview sort() works differently)
  const asArray = step3.array();
  asArray.sort((a, b) => {
    const pa = a.parsed, pb = b.parsed;
    if (pa.year !== pb.year) return pa.year - pb.year;
    if (pa.month !== pb.month) return pa.month - pb.month;
    if (pa.week !== pb.week) return pa.week - pb.week;
    if (pa.day !== pb.day) return pa.day - pb.day;
    return 0;
  });

  const planFiles = asArray.map(f => f.name);

  // Find current file's position
  const currentIndex = planFiles.indexOf(currentFile);
  const prevFile = currentIndex > 0 ? planFiles[currentIndex - 1] : null;
  const nextFile = currentIndex < planFiles.length - 1 ? planFiles[currentIndex + 1] : null;
  const parentFile = getParentFilename(currentFile);
  const parentExists = parentFile && dv.page(`plans/${parentFile}`);

  // Build navigation with flex layout: Previous (left), Up (center), Next (right)
  const container = dv.el('div', '', {
    attr: { style: 'display: flex; width: 100%; margin-bottom: 0.5em;' }
  });

  // Left: Previous (1/3 width, left-aligned)
  const leftSpan = dv.el('span', '', {
    container,
    attr: { style: 'flex: 1; text-align: left;' }
  });
  if (prevFile) {
    dv.el('a', '← Previous', {
      container: leftSpan,
      attr: { href: `plans/${prevFile}`, class: 'internal-link' }
    });
  }

  // Center: Up (1/3 width, center-aligned)
  const centerSpan = dv.el('span', '', {
    container,
    attr: { style: 'flex: 1; text-align: center;' }
  });
  if (parentExists) {
    dv.el('a', '↑ Up', {
      container: centerSpan,
      attr: { href: `plans/${parentFile}`, class: 'internal-link' }
    });
  }

  // Right: Next (1/3 width, right-aligned)
  const rightSpan = dv.el('span', '', {
    container,
    attr: { style: 'flex: 1; text-align: right;' }
  });
  if (nextFile) {
    dv.el('a', 'Next →', {
      container: rightSpan,
      attr: { href: `plans/${nextFile}`, class: 'internal-link' }
    });
  }
}

// ============================================================================
// Shared variables for other widget types
// ============================================================================
const startDate = input.startDate ? new Date(input.startDate) : null;
const weekNum = input.weekNum;

// Shared: Calculate end of week
const endDate = startDate ? new Date(startDate) : null;
if (endDate) endDate.setDate(endDate.getDate() + 6);

// Shared: Format date as YYYY-MM-DD
function formatDate(d) {
  return d.toISOString().split('T')[0];
}

// Shared: Create styled card container
function createCard(color) {
  return dv.el('div', '', {
    attr: { style: `background: var(--background-secondary); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; border-left: 4px solid var(--color-${color});` }
  });
}

// Shared: Create muted header text
function createCardHeader(container, text) {
  dv.el('div', text, {
    container,
    attr: { style: 'font-size: 0.85em; color: var(--text-muted); margin-bottom: 8px;' }
  });
}

// ============================================================================
// Type: daily-links - Links to each day's plan file with summaries
// ============================================================================
if (type === 'daily-links') {
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const y = d.getFullYear();
    const q = Math.ceil((d.getMonth() + 1) / 3);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const ww = String(weekNum).padStart(2, '0');
    const file = `${y}_Q${q}_${m}_W${ww}_${day}`;
    const dateStr = `${monthNames[d.getMonth()]} ${d.getDate()}`;

    const dailyPage = dv.page(`plans/${file}`);
    const summary = dailyPage?.daily_summary || '';

    const container = dv.el('div', '', { cls: 'daily-link-item' });
    const link = dv.el('strong', '', { container });
    dv.el('a', `${dayNames[i]} ${dateStr}`, {
      container: link,
      attr: { href: `plans/${file}`, class: 'internal-link' }
    });

    if (summary) {
      dv.el('p', summary, { container, cls: 'daily-summary' });
    }
  }
}

// ============================================================================
// Type: notes - Display notes from a folder (progress, concerns, etc.)
// ============================================================================
else if (type === 'notes') {
  const folder = input.folder || 'progress';
  const color = input.color || 'green';

  endDate.setHours(23, 59, 59, 999);

  function parseDateFromFilename(filename) {
    const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      return new Date(match[1], parseInt(match[2]) - 1, match[3]);
    }
    return null;
  }

  const noteFiles = dv.pages(`"notes/${folder}"`)
    .where(p => {
      const fileDate = parseDateFromFilename(p.file.name);
      if (!fileDate) return false;
      return fileDate >= startDate && fileDate <= endDate;
    })
    .sort(p => p.file.name, 'asc');

  if (noteFiles.length === 0) {
    dv.paragraph(`*No ${folder} notes recorded this week.*`);
  } else {
    for (const file of noteFiles) {
      const content = await dv.io.load(file.file.path);
      const lines = content.split('\n');
      const dateHeader = lines[0].trim();
      const body = lines.slice(2).join('\n').trim();

      const container = createCard(color);
      createCardHeader(container, dateHeader);
      const bodyEl = dv.el('div', '', { container });
      bodyEl.innerHTML = body.replace(/^- /gm, '').replace(/\n/g, '<br>');
    }
  }
}

// ============================================================================
// Type: previous-priorities - Show last week's priorities
// ============================================================================
else if (type === 'previous-priorities') {
  const prevWeekNum = weekNum - 1;
  const prevStartDate = new Date(startDate);
  prevStartDate.setDate(prevStartDate.getDate() - 7);

  const y = prevStartDate.getFullYear();
  const q = Math.ceil((prevStartDate.getMonth() + 1) / 3);
  const m = String(prevStartDate.getMonth() + 1).padStart(2, '0');
  const prevFile = `plans/${y}_Q${q}_${m}_W${prevWeekNum}_00`;

  const prevPage = dv.page(prevFile);

  if (prevPage && prevPage.week_priorities) {
    const container = createCard('purple');
    createCardHeader(container, "Last week's priorities:");
    dv.el('div', prevPage.week_priorities, { container });
  } else {
    dv.paragraph('*No priorities recorded for the previous week.*');
  }
}

// ============================================================================
// Type: projects - Show projects with completed tasks this week
// ============================================================================
else if (type === 'projects') {
  const startStr = formatDate(startDate);
  const endStr = formatDate(endDate);

  const projectFiles = dv.pages('"projects"')
    .where(p => !p.file.path.includes('zz-attachments') && !p.file.path.includes('completed'));

  const projectsWithActivity = [];

  for (const project of projectFiles) {
    const completedTasks = project.file.tasks
      .where(t => t.completed && t.text.includes('✅'))
      .filter(t => {
        const match = t.text.match(/✅\s*(\d{4}-\d{2}-\d{2})/);
        if (match) {
          const doneDate = match[1];
          return doneDate >= startStr && doneDate <= endStr;
        }
        return false;
      });

    if (completedTasks.length > 0) {
      projectsWithActivity.push({
        name: project.file.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        path: project.file.path,
        tasks: completedTasks,
        count: completedTasks.length
      });
    }
  }

  if (projectsWithActivity.length === 0) {
    dv.paragraph('*No project tasks completed this week.*');
  } else {
    projectsWithActivity.sort((a, b) => b.count - a.count);

    for (const project of projectsWithActivity) {
      // Use details/summary for collapsible task list
      const details = dv.el('details', '', {
        attr: { style: 'background: var(--background-secondary); border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; border-left: 4px solid var(--color-blue);' }
      });

      const summary = dv.el('summary', '', {
        container: details,
        attr: { style: 'cursor: pointer; list-style: none;' }
      });
      dv.el('a', project.name, {
        container: summary,
        attr: { href: project.path, class: 'internal-link', style: 'font-weight: bold;' }
      });
      dv.el('span', ` (${project.count} task${project.count > 1 ? 's' : ''})`, {
        container: summary,
        attr: { style: 'color: var(--text-muted);' }
      });

      const taskList = dv.el('ul', '', {
        container: details,
        attr: { style: 'margin: 8px 0 0 0; padding-left: 20px;' }
      });

      for (const task of project.tasks) {
        let taskText = task.text
          .replace(/✅\s*\d{4}-\d{2}-\d{2}/, '')
          .replace(/➕\s*\d{4}-\d{2}-\d{2}/, '')
          .replace(/#\S+/g, '')
          .replace(/[⏫🔺🔼🔽⏬]/g, '')
          .replace(/<!--.*?-->/g, '')
          .trim();

        dv.el('li', taskText, { container: taskList });
      }
    }
  }
}

// ============================================================================
// Unknown type
// ============================================================================
else if (type !== 'navigation') {
  dv.paragraph(`*Unknown widget type: ${type}. Valid types: navigation, daily-links, notes, previous-priorities, projects*`);
}

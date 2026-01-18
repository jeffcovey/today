// Weekly Projects Widget
// Displays projects with tasks completed during the week
// Usage: await dv.view("scripts/weekly-projects", { startDate: page.start_date })

const startDate = new Date(input.startDate);
const endDate = new Date(startDate);
endDate.setDate(endDate.getDate() + 6);

// Format dates for comparison (YYYY-MM-DD)
function formatDate(d) {
  return d.toISOString().split('T')[0];
}

const startStr = formatDate(startDate);
const endStr = formatDate(endDate);

// Get all project files
const projectFiles = dv.pages('"projects"')
  .where(p => !p.file.path.includes('zz-attachments') && !p.file.path.includes('completed'));

const projectsWithActivity = [];

for (const project of projectFiles) {
  // Get completed tasks from this project
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
  // Sort by task count descending
  projectsWithActivity.sort((a, b) => b.count - a.count);

  for (const project of projectsWithActivity) {
    const container = dv.el('div', '', {
      attr: { style: 'background: var(--background-secondary); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; border-left: 4px solid var(--color-blue);' }
    });

    // Project header with link and count
    const header = dv.el('div', '', { container });
    dv.el('a', project.name, {
      container: header,
      attr: { href: project.path, class: 'internal-link', style: 'font-weight: bold;' }
    });
    dv.el('span', ` (${project.count} task${project.count > 1 ? 's' : ''})`, {
      container: header,
      attr: { style: 'color: var(--text-muted);' }
    });

    // Task list
    const taskList = dv.el('ul', '', {
      container,
      attr: { style: 'margin: 8px 0 0 0; padding-left: 20px;' }
    });

    for (const task of project.tasks) {
      // Clean up task text - remove emoji markers, dates, tags
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

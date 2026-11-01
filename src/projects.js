/**
 * Shared project queries and writes, used by bin/projects, the web view and
 * the MCP server so "due for review" means the same thing everywhere.
 */

import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// How many days a review lasts for each review_frequency.
export const REVIEW_FREQUENCY_DAYS = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  yearly: 365,
};

export const REVIEW_FREQUENCIES = Object.keys(REVIEW_FREQUENCY_DAYS);

const DUE_FOR_REVIEW_CONDITION = `
  status IN ('active', 'planning')
  AND review_frequency IS NOT NULL
  AND (
    last_reviewed IS NULL
    ${REVIEW_FREQUENCIES.map(f => `OR (review_frequency = '${f}' AND julianday(@today) - julianday(last_reviewed) >= ${REVIEW_FREQUENCY_DAYS[f]})`).join('\n    ')}
  )`;

/**
 * Projects overdue for review, longest since review first, never-reviewed last.
 * The rule bin/projects review has always used.
 */
export function getProjectsDueForReview(db, today) {
  return db.prepare(`
    SELECT id, title, status, priority, review_frequency, last_reviewed, url, source,
           julianday(@today) - julianday(last_reviewed) AS days_since
    FROM projects
    WHERE ${DUE_FOR_REVIEW_CONDITION}
    ORDER BY
      CASE
        WHEN last_reviewed IS NULL THEN 0
        ELSE julianday(@today) - julianday(last_reviewed)
      END DESC
  `).all({ today });
}

/**
 * Add days to a YYYY-MM-DD date, in UTC so the server's time zone can't
 * shift the result by a day.
 */
export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * When a project is next due for review, or null if it has no schedule.
 * A project never reviewed is due now.
 */
export function nextReviewDate(project, today) {
  const days = REVIEW_FREQUENCY_DAYS[project.review_frequency];
  if (!days) return null;
  if (!project.last_reviewed) return today;
  return addDays(String(project.last_reviewed).slice(0, 10), days);
}

/**
 * Projects with optional filters. Completed and archived projects are left
 * out unless include_completed or a status filter asks for them.
 */
export function listProjects(db, filters = {}, { today } = {}) {
  const conditions = [];
  const params = { today };

  if (filters.due_for_review) {
    return getProjectsDueForReview(db, today);
  }

  if (!filters.include_completed && !filters.status) {
    conditions.push("status NOT IN ('completed', 'archived')");
  }
  for (const field of ['status', 'topic', 'priority', 'source']) {
    if (filters[field]) {
      conditions.push(`${field} = @${field}`);
      params[field] = filters[field];
    }
  }
  if (filters.has_review) {
    conditions.push('review_frequency IS NOT NULL');
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`
    SELECT id, title, status, priority, topic, due_date, progress,
           review_frequency, last_reviewed, url, source
    FROM projects
    ${whereClause}
    ORDER BY
      CASE status WHEN 'active' THEN 1 WHEN 'planning' THEN 2 WHEN 'on_hold' THEN 3 ELSE 4 END,
      CASE priority
        WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3
        WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 ELSE 6
      END,
      due_date NULLS LAST,
      title
  `).all(params);
}

/**
 * A project by exact id, or else the first whose title or id contains the
 * text, as bin/projects show has always matched.
 */
export function findProject(db, idOrTitle) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(idOrTitle)
    || db.prepare('SELECT * FROM projects WHERE title LIKE ? OR id LIKE ?').get(`%${idOrTitle}%`, `%${idOrTitle}%`)
    || null;
}

export function parseMetadata(project) {
  if (!project?.metadata) return {};
  try {
    return JSON.parse(project.metadata);
  } catch {
    return {};
  }
}

/**
 * Open and closed item counts for a project, from inline items
 * (github-projects) or an item_query (markdown-projects).
 */
export function getProjectItemCounts(db, metadata) {
  if (metadata.items && metadata.items.length > 0) {
    const open = metadata.items.filter(i => i.state === 'open').length;
    const closed = metadata.items.filter(i => i.state === 'closed' || i.state === 'merged').length;
    return { open, closed };
  }

  if (metadata.item_query) {
    const q = metadata.item_query;
    const result = db.prepare(`
      SELECT
        SUM(CASE WHEN ${q.status_field} = ? THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN ${q.status_field} = ? THEN 1 ELSE 0 END) as closed
      FROM ${q.table}
      WHERE id LIKE ?
    `).get(q.status_open, q.status_closed, q.id_pattern);

    if (result) {
      return { open: result.open || 0, closed: result.closed || 0 };
    }
  }

  return null;
}

/**
 * A project's items as { title, state, number?, repository?, url?, id? }.
 */
export function getProjectItems(db, metadata, includeAll = false) {
  if (metadata.items && metadata.items.length > 0) {
    let items = metadata.items;
    if (!includeAll) {
      items = items.filter(i => i.state === 'open');
    }
    return items.map(i => ({
      title: i.title,
      state: i.state,
      number: i.number,
      repository: i.repository,
      url: i.url || null
    }));
  }

  if (metadata.item_query) {
    const q = metadata.item_query;
    let sql = `SELECT id, ${q.title_field} as title, ${q.status_field} as status FROM ${q.table} WHERE id LIKE ?`;
    if (!includeAll) {
      sql += ` AND ${q.status_field} = '${q.status_open}'`;
    }
    sql += ` ORDER BY ${q.status_field}, ${q.title_field}`;

    const rows = db.prepare(sql).all(q.id_pattern);
    return rows.map(r => ({
      title: r.title,
      state: r.status === q.status_open ? 'open' : 'closed',
      id: r.id
    }));
  }

  return [];
}

/**
 * Run a projects plugin's write.js the way bin/projects does, without
 * blocking the event loop.
 *
 * @returns {Promise<object>} the plugin's JSON reply ({ success, ... })
 */
export function runProjectWrite(project, writeArgs, { projectRoot = PROJECT_ROOT } = {}) {
  const pluginName = project.source.split('/')[0];
  const metadata = parseMetadata(project);
  const args = { ownerType: metadata.owner_type ?? null, ...writeArgs, projectId: project.id };
  const script = path.join(projectRoot, 'plugins', pluginName, 'write.js');

  return new Promise(resolve => {
    execFile(process.execPath, [script], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 2 * 60 * 1000,
      env: { ...process.env, PLUGIN_WRITE_ARGS: JSON.stringify(args), PROJECT_ROOT: projectRoot },
    }, (error, stdout) => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({
          success: false,
          error: error?.code === 'ENOENT' || /Cannot find module/.test(error?.message || '')
            ? `Plugin ${pluginName} does not support writing projects`
            : (error?.message || 'The plugin gave no reply'),
        });
      }
    });
  });
}

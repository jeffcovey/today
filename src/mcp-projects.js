/**
 * The MCP server's project tools: list_projects, get_project and
 * mark_project_reviewed. Each takes the database and its arguments and
 * returns plain data, so they can be tested without the server.
 */

import { getEnabledPlugins, syncPluginSource } from './plugin-loader.js';
import { getAbsoluteVaultPath } from './config.js';
import {
  listProjects,
  findProject,
  nextReviewDate,
  addDays,
  isCalendarDate,
  parseMetadata,
  getProjectItemCounts,
  getProjectItems,
  runProjectWrite,
  REVIEW_FREQUENCY_DAYS,
  REVIEW_FREQUENCIES,
  REVIEWABLE_STATUSES,
} from './projects.js';

// get_project lists at most this many open items, with the count of the rest.
export const PROJECT_ITEMS_LIMIT = 50;

export const PROJECT_TOOL_DEFINITIONS = [
  {
    name: 'list_projects',
    description: 'List projects. With due_for_review: true, lists only the active or planning projects overdue for review (the same rule as bin/projects review), longest since review first and never-reviewed last, and the other filters are ignored.',
    inputSchema: {
      type: 'object',
      properties: {
        due_for_review: { type: 'boolean', description: 'Only projects overdue for review' },
        status: { type: 'string', description: 'Filter by status (planning, active, on_hold, completed, archived)' },
        topic: { type: 'string', description: 'Filter by topic' },
        priority: { type: 'string', description: 'Filter by priority' },
        source: { type: 'string', description: 'Filter by source (e.g. markdown-projects/local)' },
        has_review: { type: 'boolean', description: 'Only projects with a review schedule' },
        include_completed: { type: 'boolean', description: 'Include completed and archived projects' },
      },
    },
  },
  {
    name: 'get_project',
    description: 'Get one project: its details, review schedule, item counts and open items.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project id, or part of its title or id' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mark_project_reviewed',
    description: "Mark a project reviewed today: its next review is set one review period from today (or to next_review_date), keeping its review frequency.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project id, or part of its title or id' },
        next_review_date: { type: 'string', description: 'Next review date (YYYY-MM-DD) instead of one period from today' },
        frequency: { type: 'string', enum: REVIEW_FREQUENCIES, description: "Review frequency to set; required if the project has none" },
      },
      required: ['id'],
    },
  },
];

export const PROJECT_WRITE_TOOLS = ['mark_project_reviewed'];

function withReviewInfo(project, today) {
  const next = nextReviewDate(project, today);
  // Same rule as getProjectsDueForReview: on-hold or finished projects are
  // never due, however long since their last review.
  const reviewable = REVIEWABLE_STATUSES.includes(project.status);
  const out = { ...project, next_review: next, due_for_review: reviewable && next !== null && next <= today };
  if (out.days_since != null) out.days_since = Math.floor(out.days_since);
  return out;
}

/**
 * @returns {{summary: string, projects: object[]}}
 */
export function listProjectsTool(db, args = {}, { today }) {
  const projects = listProjects(db, args, { today }).map(p => withReviewInfo(p, today));
  const summary = args.due_for_review
    ? (projects.length === 0
      ? 'No projects are due for review.'
      : `${projects.length} project${projects.length === 1 ? ' is' : 's are'} due for review.`)
    : `${projects.length} project${projects.length === 1 ? '' : 's'}.`;
  return { summary, projects };
}

/**
 * @returns {object|null} the project, or null if nothing matches
 */
export function getProjectTool(db, args, { today }) {
  const project = findProject(db, args.id);
  if (!project) return null;

  const metadata = parseMetadata(project);
  const { metadata: _raw, ...fields } = project;
  const openItems = getProjectItems(db, metadata);
  // github-projects caches only the first page of a project's items but
  // records the real total; say so rather than present a partial count as whole.
  const cachedItems = metadata.items?.length ?? 0;
  const partial = Number.isInteger(metadata.item_count) && metadata.item_count > cachedItems;
  return {
    ...withReviewInfo(fields, today),
    item_counts: getProjectItemCounts(db, metadata),
    open_items: openItems.slice(0, PROJECT_ITEMS_LIMIT),
    open_items_not_shown: Math.max(0, openItems.length - PROJECT_ITEMS_LIMIT),
    ...(partial ? {
      items_partial: true,
      items_note: `Counts and items cover only the first ${cachedItems} of ${metadata.item_count} items; more open items may exist.`,
    } : {}),
  };
}

async function syncProjectSource(db, sourceId) {
  const [pluginName, sourceName] = sourceId.split('/');
  const enabled = await getEnabledPlugins();
  for (const { plugin, sources } of enabled) {
    if (plugin.name !== pluginName) continue;
    const source = sources.find(s => s.sourceName === sourceName);
    if (!source) break;
    const context = { db, vaultPath: getAbsoluteVaultPath() };
    return syncPluginSource(plugin, sourceName, source.config, context, { skipAutoTag: true, _caller: 'write-sync' });
  }
  return { success: false, message: `Source ${sourceId} is not enabled` };
}

/**
 * @returns {Promise<{success: boolean, error?: string, project?: object,
 *   next_review_date?: string, frequency?: string, warning?: string}>}
 */
export async function markProjectReviewed(db, args, {
  today,
  write = runProjectWrite,
  sync = syncProjectSource,
} = {}) {
  // A write must not land on a near-miss: a partial match counts only when
  // it is the only one.
  let project = db.prepare('SELECT * FROM projects WHERE id = ?').get(args.id);
  if (!project) {
    const matches = db.prepare('SELECT * FROM projects WHERE title LIKE ? OR id LIKE ? ORDER BY title')
      .all(`%${args.id}%`, `%${args.id}%`);
    if (matches.length > 1) {
      return {
        success: false,
        error: `"${args.id}" matches ${matches.length} projects. Pass one id: ${matches.slice(0, 10).map(m => `${m.title} (${m.id})`).join('; ')}`,
      };
    }
    project = matches[0];
  }
  if (!project) return { success: false, error: `Project not found: ${args.id}` };

  const frequency = args.frequency || project.review_frequency;
  if (!REVIEW_FREQUENCY_DAYS[frequency]) {
    return {
      success: false,
      error: frequency
        ? `Unknown review frequency: ${frequency}. Use one of ${REVIEW_FREQUENCIES.join(', ')}.`
        : `"${project.title}" has no review frequency. Pass frequency (${REVIEW_FREQUENCIES.join(', ')}).`,
    };
  }

  const nextDate = args.next_review_date || addDays(today, REVIEW_FREQUENCY_DAYS[frequency]);
  if (!isCalendarDate(nextDate)) {
    return { success: false, error: 'next_review_date must be a real date in YYYY-MM-DD form' };
  }

  // set-review-date is how both project plugins record a review: the next
  // review date, from which markdown-projects works back to last_reviewed.
  // github-projects resets the frequency to weekly unless it is passed, so
  // always pass it.
  const result = await write(project, { action: 'set-review-date', reviewDate: nextDate, frequency });
  if (!result?.success) {
    return { success: false, error: result?.error || 'The project plugin did not save the review' };
  }

  let warning;
  try {
    const syncResult = await sync(db, project.source);
    if (syncResult && syncResult.success === false) {
      warning = `Saved, but the database has not caught up yet: ${syncResult.message || syncResult.error}`;
    } else if (/sync already in progress/.test(syncResult?.message || '')) {
      // syncPluginSource reports a skipped, locked source as a success.
      warning = 'Saved, but another sync of this source was running, so the database may still show the old review date until the next sync.';
    }
  } catch (error) {
    warning = `Saved, but the database has not caught up yet: ${error.message}`;
  }

  // Read the schedule back as Today now records it. github-projects, for one,
  // derives last_reviewed from project activity and its configured frequency,
  // so an explicit date or frequency may not be what it reads back.
  const after = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
  const recorded = after ? nextReviewDate(after, today) : null;
  if (!warning && recorded !== nextDate) {
    warning = `Saved to the plugin, but Today now records the next review as ${recorded ?? 'unscheduled'}${after?.review_frequency ? ` (${after.review_frequency})` : ''}, not ${nextDate}.`;
  }

  return {
    success: true,
    project: { id: project.id, title: project.title },
    next_review_date: nextDate,
    frequency,
    recorded_next_review: recorded,
    ...(warning ? { warning } : {}),
  };
}

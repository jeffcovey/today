/**
 * The review schedule `set-review-date` saves on a GitHub project, read back.
 *
 * write.js keeps it on a "[META] <project> Review Schedule" issue in the
 * project: the date in the item's "Next Review Date" field, the frequency in
 * the issue body ("**Review Frequency:** weekly"). Without this the reader
 * derived the schedule from project activity alone, so a date or frequency
 * set with bin/projects set-review-date or mark_project_reviewed was lost.
 */

import { REVIEW_FREQUENCY_DAYS, addDays, isCalendarDate } from '../../src/projects.js';

/**
 * The metadata issue's body. savedReviewSchedule parses the same lines back.
 */
export function buildMetadataIssueBody(projectTitle, reviewDate, frequency) {
  const dayOfWeek = new Date(`${reviewDate}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC'
  });

  return `This issue tracks review scheduling for the ${projectTitle} project.

**Next Review Date:** ${reviewDate} (${dayOfWeek})
**Review Frequency:** ${frequency}

This is a metadata issue for project management - not a development task.`;
}

export function isReviewMetadataContent(content) {
  return Boolean(
    content?.title?.includes('[META]') &&
    content.title.includes('Review Schedule')
  );
}

/**
 * Find the saved schedule among a project's item nodes.
 * @returns {{nextReviewDate: string, frequency: string|null}|null}
 */
export function savedReviewSchedule(itemNodes = []) {
  const item = itemNodes.find(node => isReviewMetadataContent(node?.content));
  if (!item) return null;

  const dateValue = (item.fieldValues?.nodes || []).find(v =>
    v?.date && v.field?.name?.toLowerCase() === 'next review date'
  );
  const fromBody = item.content.body?.match(/\*\*Next Review Date:\*\*\s*(\d{4}-\d{2}-\d{2})/)?.[1];
  const nextReviewDate = dateValue?.date || fromBody;
  if (!isCalendarDate(nextReviewDate)) return null;

  const frequency = item.content.body?.match(/\*\*Review Frequency:\*\*\s*([a-z]+)/i)?.[1]?.toLowerCase();
  return {
    nextReviewDate,
    frequency: REVIEW_FREQUENCY_DAYS[frequency] ? frequency : null,
  };
}

/**
 * review_frequency and last_reviewed for a project row: the saved schedule
 * when there is one (last_reviewed is the next review minus one period, as
 * markdown-projects stores it), otherwise the activity-based fallback.
 */
export function reviewFields(itemNodes, fallback) {
  const saved = savedReviewSchedule(itemNodes);
  if (!saved) return fallback;
  const frequency = saved.frequency || fallback.review_frequency;
  const days = REVIEW_FREQUENCY_DAYS[frequency];
  if (!days) return fallback;
  return {
    review_frequency: frequency,
    last_reviewed: addDays(saved.nextReviewDate, -days),
  };
}

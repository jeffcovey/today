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

// How far findReviewMetadataItem looks past the sync query's first page:
// about the 1,000 items write.js searches before it gives up.
export const REVIEW_METADATA_PAGE_SIZE = 100;
export const MAX_REVIEW_METADATA_PAGES = 10;

const ITEM_PAGE_QUERY = `
  query($id: ID!, $after: String!) {
    node(id: $id) {
      ... on ProjectV2 {
        items(first: ${REVIEW_METADATA_PAGE_SIZE}, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            fieldValues(first: 10) {
              nodes {
                ... on ProjectV2ItemFieldDateValue {
                  date
                  field { ... on ProjectV2Field { name } }
                }
              }
            }
            content { ... on Issue { title } }
          }
        }
      }
    }
  }`;

const ITEM_BODY_QUERY = `
  query($id: ID!) {
    node(id: $id) {
      ... on ProjectV2Item {
        content { ... on Issue { body } }
      }
    }
  }`;

/**
 * The project's review metadata item with its issue body, or null.
 *
 * The sync query fetches one page of items and no issue bodies, since a body
 * for every item could overrun the reader's output buffer. So this finds the
 * metadata issue by title, on later pages too, and then fetches only its body.
 *
 * @param {object} project - a project node from the sync query, with id and
 *   items { nodes, pageInfo }
 * @param {(query: string, variables: object) => object} graphql - runs a
 *   query and returns its data; may throw
 */
export function findReviewMetadataItem(project, graphql, { maxPages = MAX_REVIEW_METADATA_PAGES } = {}) {
  let item = (project.items?.nodes || []).find(node => isReviewMetadataContent(node?.content));
  let pageInfo = project.items?.pageInfo;
  for (let page = 0; !item && pageInfo?.hasNextPage && page < maxPages; page++) {
    const items = graphql(ITEM_PAGE_QUERY, { id: project.id, after: pageInfo.endCursor })?.node?.items;
    item = (items?.nodes || []).find(node => isReviewMetadataContent(node?.content));
    pageInfo = items?.pageInfo;
  }
  if (!item) return null;

  const body = graphql(ITEM_BODY_QUERY, { id: item.id })?.node?.content?.body ?? null;
  return { ...item, content: { ...item.content, body } };
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

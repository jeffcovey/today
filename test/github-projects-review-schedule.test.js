/**
 * github-projects keeps the review schedule set-review-date saves, instead of
 * replacing it with one derived from project activity.
 */

import {
  buildMetadataIssueBody,
  savedReviewSchedule,
  reviewFields,
  findReviewMetadataItem,
} from '../plugins/github-projects/review-schedule.js';
import { nextReviewDate } from '../src/projects.js';

// A project item node as the reader's GraphQL query returns it.
function metadataItem({ title = '[META] Big board Review Schedule', date, body }) {
  return {
    id: 'PVTI_meta',
    type: 'ISSUE',
    fieldValues: {
      nodes: [
        ...(date ? [{ date, field: { name: 'Next Review Date' } }] : []),
        { name: 'Todo', field: { name: 'Status' } },
      ],
    },
    content: { number: 12, title, state: 'OPEN', url: 'https://example.invalid/12', body },
  };
}

const ordinaryItem = {
  id: 'PVTI_1',
  type: 'ISSUE',
  fieldValues: { nodes: [{ date: '2026-12-01', field: { name: 'Due Date' } }] },
  content: { number: 3, title: 'Ship it', state: 'OPEN', body: '**Next Review Date:** 2020-01-01' },
};

const activityFallback = { review_frequency: 'weekly', last_reviewed: '2026-11-01' };

describe('savedReviewSchedule', () => {
  test('reads back what write.js saves', () => {
    const body = buildMetadataIssueBody('Big board', '2027-01-15', 'monthly');
    expect(savedReviewSchedule([ordinaryItem, metadataItem({ date: '2027-01-15', body })]))
      .toEqual({ nextReviewDate: '2027-01-15', frequency: 'monthly' });
  });

  test('falls back to the date in the body when the field is not set', () => {
    const body = buildMetadataIssueBody('Big board', '2027-01-15', 'quarterly');
    expect(savedReviewSchedule([metadataItem({ body })]))
      .toEqual({ nextReviewDate: '2027-01-15', frequency: 'quarterly' });
  });

  test('ignores ordinary items, missing items and unusable dates', () => {
    expect(savedReviewSchedule([ordinaryItem])).toBeNull();
    expect(savedReviewSchedule(undefined)).toBeNull();
    expect(savedReviewSchedule([metadataItem({ date: '2027-02-30', body: '' })])).toBeNull();
    expect(savedReviewSchedule([metadataItem({ date: '2027-01-15', body: '**Review Frequency:** fortnightly' })]))
      .toEqual({ nextReviewDate: '2027-01-15', frequency: null });
  });
});

describe('reviewFields', () => {
  test('a saved schedule replaces the activity-based one and round-trips', () => {
    const body = buildMetadataIssueBody('Big board', '2027-01-15', 'monthly');
    const fields = reviewFields([metadataItem({ date: '2027-01-15', body })], activityFallback);
    expect(fields).toEqual({ review_frequency: 'monthly', last_reviewed: '2026-12-16' });
    // The date mark_project_reviewed asked for is the date Today now shows.
    expect(nextReviewDate(fields, '2026-11-01')).toBe('2027-01-15');
  });

  test('a saved date without a known frequency uses the configured one', () => {
    const fields = reviewFields([metadataItem({ date: '2026-11-08', body: '' })], activityFallback);
    expect(fields).toEqual({ review_frequency: 'weekly', last_reviewed: '2026-11-01' });
  });

  test('no saved schedule, or a frequency with no period, keeps the fallback', () => {
    expect(reviewFields([ordinaryItem], activityFallback)).toBe(activityFallback);
    const closed = { review_frequency: 'never', last_reviewed: '2026-10-01' };
    expect(reviewFields([metadataItem({ date: '2026-11-08', body: '' })], closed)).toBe(closed);
  });
});

describe('findReviewMetadataItem', () => {
  const body = buildMetadataIssueBody('Big board', '2027-01-15', 'monthly');
  // A fake gh: item pages by cursor, and the body of the metadata item.
  const fakeGraphql = (pages) => {
    const calls = [];
    const graphql = (query, variables) => {
      calls.push(variables);
      if (variables.after) return { node: { items: pages[variables.after] } };
      return { node: { content: { body } } };
    };
    return { graphql, calls };
  };
  const withoutBody = ({ content: { body: _body, ...content }, ...item }) => ({ ...item, content });
  const meta = withoutBody(metadataItem({ date: '2027-01-15' }));
  const plain = withoutBody(ordinaryItem);

  test('on the first page: fetches only that issue body', () => {
    const { graphql, calls } = fakeGraphql({});
    const project = { id: 'P', items: { nodes: [plain, meta], pageInfo: { hasNextPage: true, endCursor: 'c1' } } };
    const item = findReviewMetadataItem(project, graphql);
    expect(calls).toEqual([{ id: 'PVTI_meta' }]);
    expect(reviewFields([item], activityFallback)).toEqual({ review_frequency: 'monthly', last_reviewed: '2026-12-16' });
  });

  test('past the first page: pages by title, then fetches the body', () => {
    const { graphql, calls } = fakeGraphql({
      c1: { nodes: [plain], pageInfo: { hasNextPage: true, endCursor: 'c2' } },
      c2: { nodes: [meta], pageInfo: { hasNextPage: false, endCursor: 'c3' } },
    });
    const project = { id: 'P', items: { nodes: [plain], pageInfo: { hasNextPage: true, endCursor: 'c1' } } };
    const item = findReviewMetadataItem(project, graphql);
    expect(calls).toEqual([{ id: 'P', after: 'c1' }, { id: 'P', after: 'c2' }, { id: 'PVTI_meta' }]);
    expect(savedReviewSchedule([item])).toEqual({ nextReviewDate: '2027-01-15', frequency: 'monthly' });
  });

  test('no metadata issue: null, after at most maxPages extra pages', () => {
    const { graphql, calls } = fakeGraphql({
      c1: { nodes: [plain], pageInfo: { hasNextPage: true, endCursor: 'c2' } },
      c2: { nodes: [plain], pageInfo: { hasNextPage: true, endCursor: 'c3' } },
    });
    const project = { id: 'P', items: { nodes: [plain], pageInfo: { hasNextPage: true, endCursor: 'c1' } } };
    expect(findReviewMetadataItem(project, graphql, { maxPages: 2 })).toBeNull();
    expect(calls).toHaveLength(2);

    const single = fakeGraphql({});
    expect(findReviewMetadataItem({ id: 'P', items: { nodes: [plain], pageInfo: { hasNextPage: false } } }, single.graphql)).toBeNull();
    expect(single.calls).toHaveLength(0);
  });
});

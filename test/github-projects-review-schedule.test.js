/**
 * github-projects keeps the review schedule set-review-date saves, instead of
 * replacing it with one derived from project activity.
 */

import {
  buildMetadataIssueBody,
  savedReviewSchedule,
  reviewFields,
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

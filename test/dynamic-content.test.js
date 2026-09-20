import { containsDynamicContent, markDynamic, DYNAMIC_CONTENT_MARKER } from '../src/dynamic-content.js';

describe('containsDynamicContent', () => {
  test('static HTML is not dynamic', () => {
    expect(containsDynamicContent('<h1>Diary</h1><p>Nothing to see</p>')).toBe(false);
  });

  test('task query and dataview table/list output is dynamic', () => {
    expect(containsDynamicContent('<div class="tasks-query-result"></div>')).toBe(true);
    expect(containsDynamicContent('<table class="dataview-table"></table>')).toBe(true);
    expect(containsDynamicContent('<ul class="dataview-list"></ul>')).toBe(true);
  });

  // Regression: the time-tracking widget with no entries yet emits none of the
  // dataview classes, so the diary page was disk-cached with
  // "No time entries for this period" and never re-rendered.
  test('marked dataviewjs output is dynamic regardless of its markup', () => {
    const widgetHtml = '<div><input type="text"></div><p>No time entries for this period</p>';
    expect(containsDynamicContent(widgetHtml)).toBe(false);
    expect(containsDynamicContent(markDynamic(widgetHtml))).toBe(true);
  });

  test('empty block output is still marked', () => {
    expect(markDynamic('')).toBe(DYNAMIC_CONTENT_MARKER);
    expect(containsDynamicContent(markDynamic(''))).toBe(true);
  });
});

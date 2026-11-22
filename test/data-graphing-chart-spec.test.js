/**
 * data-graphing: how a chart is built from query rows.
 *
 * The plugin draws bars for amounts that add up and lines for readings,
 * leaves out a partial first month, fades the period still under way, and
 * writes SVG that carries its own dark palette.
 */

import * as vega from 'vega';
import { compile } from 'vega-lite';
import {
  chartKind, windowStart, prepareData, displayNames, tickLabelExpr,
  dayTicks, buildSubtitle, buildSpec, addDarkMode, SERIES, CHROME
} from '../plugins/data-graphing/chart-spec.js';

const day = (iso, value) => ({ date: iso, value });

function days(from, n, valueOf) {
  const out = [];
  const t0 = Date.parse(`${from}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push(day(new Date(t0 + i * 86400000).toISOString().slice(0, 10), valueOf(i)));
  }
  return out;
}

const baseSettings = {
  source: 'health', metrics: [], colors: [], timePeriod: '30 days',
  width: 800, height: 450, chartTitle: '', xAxisLabel: '', yAxisLabel: '',
  chartType: 'auto', goal: NaN, averageDays: 7
};

describe('chartKind', () => {
  test('health readings are lines, daily amounts are bars', () => {
    expect(chartKind({ source: 'health', units: 'lb' })).toBe('line');
    expect(chartKind({ source: 'health', units: 'count/min' })).toBe('line');
    expect(chartKind({ source: 'health', units: 'count' })).toBe('bar');
    expect(chartKind({ source: 'health', units: 'min' })).toBe('bar');
  });

  test('other sources are totals, and chart_type overrides', () => {
    expect(chartKind({ source: 'finance', units: '$' })).toBe('bar');
    expect(chartKind({ source: 'finance', units: '$', chartType: 'line' })).toBe('line');
    expect(chartKind({ source: 'health', units: 'lb', chartType: 'bar' })).toBe('bar');
  });
});

describe('windowStart', () => {
  test('counts back by calendar unit', () => {
    expect(windowStart('2026-11-22', '6 months')).toBe('2026-05-22');
    expect(windowStart('2026-11-22', '30 days')).toBe('2026-10-23');
    expect(windowStart('2026-11-22', '2 weeks')).toBe('2026-11-08');
    expect(windowStart('2026-11-22', '1 year')).toBe('2025-11-22');
  });
});

describe('prepareData', () => {
  test('a monthly window starting mid-month drops that partial first month', () => {
    const rows = ['2025-11', '2025-12', '2026-10', '2026-11'].map(m => day(m, 100));
    const data = prepareData([{ metric: 'Income', rows }], {
      today: '2026-11-22', timePeriod: '12 months', kind: 'bar'
    });
    expect(data.monthly).toBe(true);
    expect(data.skippedPartial).toBe(true);
    expect(data.start).toBe('2025-12-01');
    expect(data.points.map(p => p.date)).toEqual(['2025-12-01', '2026-10-01', '2026-11-01']);
    expect(data.points.map(p => p.partial)).toEqual([false, false, true]);
    expect(data.points[0].label).toBe("Dec '25");
  });

  test("today's amount is partial; a reading is not", () => {
    const rows = days('2026-11-20', 3, () => 5000);
    const bars = prepareData([{ metric: 'Steps', rows }], { today: '2026-11-22', timePeriod: '30 days', kind: 'bar' });
    expect(bars.points.map(p => p.partial)).toEqual([false, false, true]);
    const line = prepareData([{ metric: 'Weight', rows }], { today: '2026-11-22', timePeriod: '30 days', kind: 'line' });
    expect(line.points.some(p => p.partial)).toBe(false);
  });

  test('daily data starting late moves the axis start up, but never the end', () => {
    const rows = days('2026-11-01', 5, () => 1);
    const data = prepareData([{ metric: 'Steps', rows }], { today: '2026-11-22', timePeriod: '6 months', kind: 'bar' });
    expect(data.start).toBe('2026-11-01');
    expect(data.end).toBe('2026-11-22');
  });

  test('rows outside the window are dropped', () => {
    const rows = [day('2026-10-01', 1), day('2026-11-20', 2), day('2026-11-23', 3)];
    const data = prepareData([{ metric: 'Steps', rows }], { today: '2026-11-22', timePeriod: '14 days', kind: 'bar' });
    expect(data.points.map(p => p.value)).toEqual([2]);
  });

  test('the rolling average spans calendar days, not rows', () => {
    // Readings of 100 on Nov 1-10, then 200 on Nov 14: the window for Nov 14
    // is Nov 8-14, which holds three 100s and the 200, not the last 7 rows.
    const rows = [...days('2026-11-01', 10, () => 100), day('2026-11-14', 200)];
    const data = prepareData([{ metric: 'Weight', rows }], { today: '2026-11-22', timePeriod: '30 days', kind: 'line', averageDays: 7 });
    const last = data.points[data.points.length - 1];
    expect(last.average).toBeCloseTo((100 * 3 + 200) / 4);
    expect(data.points[0].average).toBe(100);
  });

  test('too few readings for an average leaves it off', () => {
    const rows = days('2026-11-15', 5, i => 100 + i);
    const data = prepareData([{ metric: 'Weight', rows }], { today: '2026-11-22', timePeriod: '30 days', kind: 'line', averageDays: 7 });
    expect(data.points.every(p => p.average === undefined)).toBe(true);
  });
});

describe('labels', () => {
  test('a prefix every series shares is left to the title', () => {
    const names = displayNames(['OlderGay.Men: Income', 'OlderGay.Men: Expenses']);
    expect([...names.values()]).toEqual(['Income', 'Expenses']);
    expect([...displayNames(['Income', 'Expenses']).values()]).toEqual(['Income', 'Expenses']);
    expect([...displayNames(['A: Income', 'B: Expenses']).values()]).toEqual(['A: Income', 'B: Expenses']);
  });

  test('tick labels: compact from 10,000, unit carried along', async () => {
    // Evaluate the expression the way the axis will: in Vega.
    const run = async (expr, value) => {
      const view = new vega.View(vega.parse({
        signals: [{ name: 'out', init: expr.replaceAll('datum.value', `(${value})`) }]
      }), { renderer: 'none' });
      await view.runAsync();
      return view.signal('out');
    };
    expect(await run(tickLabelExpr('count', 10478, ',.0f'), 8000)).toBe('8K');
    expect(await run(tickLabelExpr('count', 10478, ',.0f'), 0)).toBe('0');
    expect(await run(tickLabelExpr('$', 4600, '$,.0f'), 3000)).toBe('$3,000');
    expect(await run(tickLabelExpr('min', 191, ',.0f'), 50)).toBe('50 min');
    expect(await run(tickLabelExpr('lb', 172, ',.1f'), 168.5)).toBe('168.5 lb');
  });

  test('day ticks always include the last day and never pass it', () => {
    const ticks = dayTicks('2026-10-23', '2026-11-22');
    expect(ticks[ticks.length - 1]).toBe('2026-11-22');
    expect(ticks[0] >= '2026-10-23').toBe(true);
    expect(dayTicks('2026-05-22', '2026-11-22')).toEqual(
      ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01']);
  });

  test('the subtitle says when data has stopped arriving', () => {
    const points = [{ series: 'Weight', date: '2026-11-15', label: 'Nov 15', value: 168.5, partial: false }];
    const text = buildSubtitle({
      kind: 'line', monthly: false, points, units: 'lb', metrics: ['Weight'],
      today: '2026-11-22', fmt: ',.1f', averageDays: 7
    });
    expect(text).toBe('Latest 168.5 lb · no data since Nov 15');
  });

  test('a daily-total subtitle leaves the partial day out of the average', () => {
    const points = [
      { date: '2026-11-21', label: 'Nov 21', value: 8000, partial: false },
      { date: '2026-11-22', label: 'Nov 22', value: 100, partial: true }
    ];
    const text = buildSubtitle({
      kind: 'bar', monthly: false, points, units: 'count', metrics: ['Steps'],
      today: '2026-11-22', fmt: ',.0f', averageDays: 7
    });
    expect(text).toBe('Average 8,000 a day · best 8,000 on Nov 21 · today so far is faded');
  });
});

describe('buildSpec renders', () => {
  async function render(spec) {
    const view = new vega.View(vega.parse(compile(spec).spec), { renderer: 'none' });
    return view.toSVG();
  }

  test('daily bars with a goal line', async () => {
    const spec = buildSpec({
      datasets: [{ metric: 'Steps', units: 'count', rows: days('2026-10-24', 30, i => 4000 + i * 200) }],
      settings: { ...baseSettings, metrics: ['Steps'], goal: 8000 },
      today: '2026-11-22'
    });
    expect(spec.layer[0].mark.type).toBe('bar');
    expect(spec.layer[0].mark.width).toBeLessThanOrEqual(24);
    const svg = await render(spec);
    expect(svg).toContain('Goal 8,000');
    expect(svg).toContain('Average');
  });

  test('a noisy reading draws dots under a rolling average', async () => {
    const spec = buildSpec({
      datasets: [{ metric: 'Weight', units: 'lb', rows: days('2026-10-23', 30, i => 168 + Math.sin(i)) }],
      settings: { ...baseSettings, source: 'health', metrics: ['Weight'], timePeriod: '6 months' },
      today: '2026-11-22'
    });
    expect(spec.layer.map(l => l.mark?.type)).toEqual(['circle', 'line', undefined]);
    expect(await render(spec)).toContain('7-day average');
  });

  test('two monthly series share a legend and keep configured colors', async () => {
    const months = ['2025-12', '2026-01', '2026-02'];
    const spec = buildSpec({
      datasets: [
        { metric: 'Biz: Income', units: '$', rows: months.map(m => day(m, 1500)) },
        { metric: 'Biz: Expenses', units: '$', rows: months.map(m => day(m, 2000)) }
      ],
      settings: {
        ...baseSettings, source: 'finance', timePeriod: '3 months',
        metrics: ['Biz: Income', 'Biz: Expenses'], colors: ['#4CAF50']
      },
      today: '2026-02-15'
    });
    expect(spec.usermeta.colors).toEqual(['#4CAF50', SERIES[1].light]);
    const svg = await render(spec);
    expect(svg).toContain('>Income<');
    expect(svg).toContain('>Expenses<');
  });
});

describe('addDarkMode', () => {
  test('maps chrome and palette colors to their dark steps, leaves custom ones', () => {
    const svg = addDarkMode('<svg width="1"><rect fill="#fcfcfb"/></svg>', [SERIES[0].light, '#4CAF50']);
    expect(svg.startsWith('<svg width="1"><style>@media (prefers-color-scheme: dark){')).toBe(true);
    expect(svg).toContain(`[fill="${CHROME.surface.light}"]{fill:${CHROME.surface.dark}}`);
    expect(svg).toContain(`[stroke="${SERIES[0].light}"]{stroke:${SERIES[0].dark}}`);
    expect(svg).not.toContain('#4CAF50');
  });
});

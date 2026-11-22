/**
 * Chart building for the data-graphing plugin.
 *
 * Pure functions: rows in, a Vega-Lite spec out, plus the SVG post-processing
 * that gives the written file its own dark palette. Rendering (vega + canvas)
 * lives in read.js so this module can be tested without either.
 */

// Reference palette: categorical slots in a fixed order, a light and a dark
// step each. A series keeps its slot whatever else is on the chart.
export const SERIES = [
  { light: '#2a78d6', dark: '#3987e5' }, // blue
  { light: '#eb6834', dark: '#d95926' }, // orange
  { light: '#1baf7a', dark: '#199e70' }, // aqua
  { light: '#eda100', dark: '#c98500' }, // yellow
  { light: '#e87ba4', dark: '#d55181' }, // magenta
  { light: '#008300', dark: '#0ca30c' }, // green
  { light: '#6250d6', dark: '#9085e9' }, // violet
  { light: '#e34948', dark: '#e66767' } // red
];

// Chart chrome. Each light value is unique within the chart so the dark
// stylesheet can find it by attribute.
export const CHROME = {
  surface: { light: '#fcfcfb', dark: '#1a1a19' },
  ink: { light: '#0b0b0b', dark: '#f0efec' },
  ink2: { light: '#52514e', dark: '#c3c2b7' },
  muted: { light: '#898781', dark: '#9a988f' },
  grid: { light: '#e1e0d9', dark: '#2c2c2a' },
  axis: { light: '#c3c2b7', dark: '#383835' }
};

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const DAY_MS = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Units of a reading taken at a moment (a line), as opposed to an amount that
// adds up over the day (a bar).
const MEASUREMENT_UNITS = /^(lb|lbs|kg|g|%|bpm|ms|mph|in|cm|db|dbaspl|degf|degc|°f|°c)$/i;

// Short units worth repeating on every tick label.
const TICK_SUFFIX = { min: ' min', lb: ' lb', lbs: ' lb', kg: ' kg', bpm: ' bpm', '%': '%', hr: ' h', hrs: ' h' };

// ---------------------------------------------------------------- dates

const toUtc = (iso) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);

export function shortDate(iso) {
  const d = new Date(toUtc(iso));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function shortMonth(iso) {
  const d = new Date(toUtc(iso));
  return `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`;
}

/**
 * First day of the window a time period covers, ending at `today`.
 * "6 months" before 2026-11-22 is 2026-05-22.
 */
export function windowStart(today, timePeriod) {
  const match = String(timePeriod).match(/(\d+)\s*(day|week|month|year)s?/i);
  const [amount, unit] = match ? [parseInt(match[1], 10), match[2].toLowerCase()] : [6, 'month'];
  const d = new Date(toUtc(today));
  if (unit === 'day') d.setUTCDate(d.getUTCDate() - amount);
  if (unit === 'week') d.setUTCDate(d.getUTCDate() - amount * 7);
  if (unit === 'month') d.setUTCMonth(d.getUTCMonth() - amount);
  if (unit === 'year') d.setUTCFullYear(d.getUTCFullYear() - amount);
  return toIso(d.getTime());
}

// ---------------------------------------------------------------- data

/**
 * Bar for amounts that add up (steps, minutes, dollars, counts); line for
 * readings (weight, heart rate). `chart_type` overrides.
 */
export function chartKind({ chartType, source, units }) {
  if (chartType === 'bar' || chartType === 'line') return chartType;
  if (source !== 'health') return 'bar';
  if (!units) return 'bar';
  return MEASUREMENT_UNITS.test(units) || units.includes('/') ? 'line' : 'bar';
}

/**
 * Turn query rows into plot rows on one calendar.
 *
 * @param {Array<{metric: string, rows: Array<{date: string, value: number}>}>} datasets
 * @param {{today: string, timePeriod: string, kind: 'bar'|'line', averageDays: number}} opts
 * @returns {{monthly: boolean, start: string, end: string, points: object[], skippedPartial: boolean}}
 */
export function prepareData(datasets, { today, timePeriod, kind, averageDays = 7 }) {
  const monthly = datasets.some(ds => ds.rows.some(r => /^\d{4}-\d{2}$/.test(r.date)));
  let start = windowStart(today, timePeriod);
  let skippedPartial = false;

  if (monthly) {
    // A window starting mid-month covers only part of its first month; that
    // month's total is not comparable with the rest, so it starts a month on.
    if (!start.endsWith('-01')) {
      const d = new Date(toUtc(start));
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 1);
      start = toIso(d.getTime());
      skippedPartial = true;
    }
  }

  const currentPeriod = monthly ? today.slice(0, 7) : today;
  const points = [];

  for (const ds of datasets) {
    const rows = ds.rows
      .filter(r => Number.isFinite(r.value))
      .map(r => ({ ...r, date: monthly && r.date.length === 7 ? `${r.date}-01` : r.date }))
      .filter(r => r.date >= start && r.date <= (monthly ? `${currentPeriod}-01` : today))
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const r of rows) {
      const point = {
        series: ds.metric,
        date: r.date,
        label: monthly ? shortMonth(r.date) : shortDate(r.date),
        value: r.value,
        // The period still under way: an amount that is still adding up.
        partial: kind === 'bar' && (monthly ? r.date.slice(0, 7) === currentPeriod : r.date === today)
      };
      points.push(point);
    }

    if (kind === 'line' && !monthly && averageDays > 1 && rows.length >= averageDays + 3) {
      // Trailing mean over calendar days, not rows, so a gap in the data
      // doesn't stretch the window.
      const byPoint = points.filter(p => p.series === ds.metric);
      for (const p of byPoint) {
        const from = toIso(toUtc(p.date) - (averageDays - 1) * DAY_MS);
        const win = rows.filter(r => r.date >= from && r.date <= p.date);
        p.average = win.reduce((s, r) => s + r.value, 0) / win.length;
      }
    }
  }

  // Daily data that only begins partway into the window (a source connected
  // recently) starts the axis at its first day rather than leaving most of
  // the chart empty. The end always stays at today, so stale data shows.
  if (!monthly && points.length) {
    const first = points.reduce((m, p) => (p.date < m ? p.date : m), points[0].date);
    if (first > start) start = first;
  }

  const end = monthly ? `${currentPeriod}-01` : today;
  return { monthly, start, end, points, skippedPartial };
}

// ---------------------------------------------------------------- formatting

/**
 * Series names without the prefix they all share: "OlderGay.Men: Income" and
 * "OlderGay.Men: Expenses" read as "Income" and "Expenses" under a title that
 * already names the group.
 */
export function displayNames(metrics) {
  const names = new Map(metrics.map(m => [m, m]));
  if (metrics.length < 2) return names;
  const prefixes = metrics.map(m => m.match(/^(.+?):\s+/)?.[1]);
  if (prefixes[0] && prefixes.every(p => p === prefixes[0])) {
    for (const m of metrics) names.set(m, m.slice(m.indexOf(':') + 1).trim());
  }
  return names;
}

/**
 * Vega expression for y tick labels: full numbers below 10,000 and compact
 * ones (10K, 20K) on an axis that reaches it; the unit rides along when short.
 */
export function tickLabelExpr(units, maxValue, fmt) {
  const prefix = units === '$' ? '$' : '';
  const suffix = TICK_SUFFIX[String(units).toLowerCase()] || '';
  const plain = `format(datum.value, '${fmt === ',.1f' ? ',~f' : ',.0f'}')`;
  const body = maxValue >= 10000
    ? `(abs(datum.value) >= 1000 ? format(datum.value / 1000, ',~f') + 'K' : ${plain})`
    : plain;
  return `'${prefix}' + ${body} + '${suffix}'`;
}

/** Tick dates for a daily axis: a few evenly spaced days, never past today. */
export function dayTicks(start, end) {
  const days = Math.round((toUtc(end) - toUtc(start)) / DAY_MS) + 1;
  const step = days <= 10 ? 1 : days <= 21 ? 2 : days <= 45 ? 7 : days <= 120 ? 14 : 0;
  const ticks = [];
  if (step) {
    // Count back from the last day so today always gets a label.
    for (let t = toUtc(end); t >= toUtc(start); t -= step * DAY_MS) ticks.unshift(toIso(t));
  } else {
    const d = new Date(toUtc(start));
    if (d.getUTCDate() !== 1) { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); }
    for (; toIso(d.getTime()) <= end; d.setUTCMonth(d.getUTCMonth() + 1)) ticks.push(toIso(d.getTime()));
  }
  return ticks;
}

/** d3-format string for values in these units. */
export function valueFormat(units, points) {
  if (units === '$') return '$,.0f';
  const max = Math.max(...points.map(p => Math.abs(p.value)), 0);
  const fractional = points.some(p => !Number.isInteger(p.value));
  return fractional && max < 1000 ? ',.1f' : ',.0f';
}

function formatNumber(value, units, fmt) {
  const decimals = fmt.includes('.1f') ? 1 : 0;
  const n = value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  if (units === '$') return `$${n}`;
  const suffix = TICK_SUFFIX[String(units).toLowerCase()];
  return suffix ? `${n}${suffix}` : n;
}

/**
 * One line under the title saying what the chart is for: where it ended up,
 * the typical value, and how fresh the data is.
 */
export function buildSubtitle({ kind, monthly, points, units, metrics, today, fmt, averageDays }) {
  if (points.length === 0) return 'No data in this period';
  const parts = [];
  const fmtN = (v) => formatNumber(v, units, fmt);
  const lastDate = points.reduce((m, p) => (p.date > m ? p.date : m), points[0].date);

  if (metrics.length > 1) {
    for (const metric of metrics) {
      const total = points.filter(p => p.series === metric).reduce((s, p) => s + p.value, 0);
      parts.push(`${metric} ${fmtN(total)}`);
    }
    parts[0] = `${monthly ? 'Totals' : 'Total'}: ${parts[0]}`;
  } else if (kind === 'line') {
    const last = points[points.length - 1];
    parts.push(`Latest ${fmtN(last.value)}`);
    if (last.average !== undefined) parts.push(`${averageDays}-day average ${fmtN(last.average)}`);
  } else {
    const whole = points.filter(p => !p.partial);
    if (whole.length) {
      const avg = whole.reduce((s, p) => s + p.value, 0) / whole.length;
      parts.push(`Average ${fmtN(avg)} a ${monthly ? 'month' : 'day'}`);
      const best = whole.reduce((m, p) => (p.value > m.value ? p : m), whole[0]);
      parts.push(`best ${fmtN(best.value)} on ${best.label}`);
    }
  }

  // Stale data should be visible at a glance, not only from the axis.
  const staleDays = Math.round((toUtc(today) - toUtc(lastDate)) / DAY_MS);
  if (!monthly && staleDays > 1) parts.push(`no data since ${shortDate(lastDate)}`);
  if (points.some(p => p.partial)) parts.push(`${monthly ? 'this month' : 'today'} so far is faded`);

  return parts.join(' · ');
}

// ---------------------------------------------------------------- spec

/**
 * Build the Vega-Lite spec.
 *
 * @param {object} p
 * @param {Array} p.datasets - [{ metric, rows, units }]
 * @param {object} p.settings - plugin settings (see read.js)
 * @param {string} p.today - YYYY-MM-DD in the user's time zone
 */
export function buildSpec({ datasets, settings, today }) {
  const metrics = datasets.map(ds => ds.metric);
  const units = datasets[0]?.units || '';
  const kind = chartKind({ chartType: settings.chartType, source: settings.source, units });
  const averageDays = settings.averageDays ?? 7;
  const data = prepareData(datasets, { today, timePeriod: settings.timePeriod, kind, averageDays });
  const { monthly } = data;
  const names = displayNames(metrics);
  const points = data.points.map(p => ({ ...p, series: names.get(p.series) }));
  const fmt = valueFormat(units, points);
  const multi = metrics.length > 1;
  const hasAverage = points.some(p => p.average !== undefined);

  // A series keeps the slot of its place in the configured list, even when
  // an earlier one has no data this time.
  const slotOf = (metric, i) => {
    const configured = (settings.metrics || []).indexOf(metric);
    return configured >= 0 ? configured : i;
  };
  const colors = metrics.map((m, i) => settings.colors?.[slotOf(m, i)] || SERIES[slotOf(m, i) % SERIES.length].light);
  const seriesNames = metrics.map(m => names.get(m));
  const color = multi
    ? { field: 'series', type: 'nominal', scale: { domain: seriesNames, range: colors }, title: null }
    : { value: colors[0] };

  const title = settings.chartTitle ||
    (multi ? metrics.join(' vs ') : metrics[0] || 'Graph');
  const subtitle = buildSubtitle({ kind, monthly, points, units, metrics: seriesNames, today, fmt, averageDays });

  // autosize "fit" makes this the size of the whole image; the plot area is
  // what remains after title, axes and legend. Bar widths use the estimate.
  const { width, height } = settings;
  const plotWidth = width - 80;

  // Tick labels carry the unit where it is short, so no axis title is needed.
  const maxValue = Math.max(0, ...points.map(p => p.value), Number.isFinite(settings.goal) ? settings.goal : 0);
  const yAxis = {
    title: settings.yAxisLabel || null,
    tickCount: 5,
    labelExpr: tickLabelExpr(units, maxValue, fmt)
  };

  let x;
  const layers = [];

  if (monthly) {
    // Months are categories here; grouped bars sit side by side in each one.
    const months = [];
    for (let d = new Date(toUtc(data.start)); toIso(d.getTime()) <= data.end; d.setUTCMonth(d.getUTCMonth() + 1)) {
      months.push(shortMonth(toIso(d.getTime())));
    }
    x = {
      field: 'label', type: 'ordinal', sort: months, scale: { domain: months, paddingInner: 0.25 },
      axis: { title: settings.xAxisLabel || null, labelAngle: 0, labelOverlap: 'greedy', ticks: false }
    };
  } else {
    // Bars span their whole day, so ticks sit at noon, under the bar.
    const offset = kind === 'bar' ? DAY_MS / 2 : 0;
    const domainEnd = kind === 'bar' ? toUtc(data.end) + DAY_MS : toUtc(data.end);
    x = {
      field: 'date', type: 'temporal',
      ...(kind === 'bar' ? { timeUnit: 'utcyearmonthdate' } : {}),
      scale: { type: 'utc', domain: [toUtc(data.start), domainEnd] },
      axis: {
        title: settings.xAxisLabel || null, labelAngle: 0, labelOverlap: true,
        values: dayTicks(data.start, data.end).map(d => toUtc(d) + offset),
        format: '%b %-d', ticks: false, grid: false
      }
    };
  }

  const y = (field, extra = {}) => ({
    field, type: 'quantitative',
    scale: { zero: kind === 'bar', nice: true },
    axis: yAxis,
    ...extra
  });

  if (kind === 'bar') {
    // Bars stay slim with air between them; side-by-side bars keep a gap.
    const periods = monthly
      ? Math.round((toUtc(data.end) - toUtc(data.start)) / (30.4 * DAY_MS)) + 1
      : Math.round((toUtc(data.end) - toUtc(data.start)) / DAY_MS) + 1;
    const band = plotWidth / Math.max(1, periods);
    const perBar = monthly ? (band * 0.75) / (multi ? metrics.length : 1) - 3 : band * 0.7;
    const barWidth = Math.max(2, Math.min(monthly ? 32 : 24, Math.floor(perBar)));
    layers.push({
      mark: { type: 'bar', width: barWidth, cornerRadiusEnd: Math.min(4, Math.floor(barWidth / 2)) },
      encoding: {
        x, y: y('value'), color,
        ...(multi && monthly ? { xOffset: { field: 'series', sort: seriesNames } } : {}),
        opacity: { condition: { test: 'datum.partial', value: 0.35 }, value: 1 }
      }
    });
  } else if (hasAverage) {
    // Daily readings as quiet dots; the trend line is what to read.
    layers.push({
      mark: { type: 'circle', size: 30, opacity: 0.5 },
      encoding: { x, y: y('value'), color }
    });
    layers.push({
      mark: { type: 'line', strokeWidth: 2.5, strokeCap: 'round', strokeJoin: 'round', interpolate: 'linear' },
      encoding: { x, y: y('average'), color }
    });
    layers.push({
      transform: [{ window: [{ op: 'row_number', as: 'rn' }], sort: [{ field: 'date', order: 'descending' }], groupby: ['series'] }, { filter: 'datum.rn === 1' }],
      layer: [
        { mark: { type: 'circle', size: 64, opacity: 1, stroke: CHROME.surface.light, strokeWidth: 2 }, encoding: { x, y: y('average'), color } },
        {
          mark: { type: 'text', align: 'right', dx: -2, dy: -14, fontSize: 12, fontWeight: 600, color: CHROME.ink.light },
          encoding: { x, y: y('average'), text: { field: 'average', format: fmt } }
        }
      ]
    });
  } else {
    layers.push({
      mark: { type: 'line', strokeWidth: 2, strokeCap: 'round', strokeJoin: 'round', interpolate: 'linear', point: { size: 40, filled: true } },
      encoding: { x, y: y('value'), color }
    });
  }

  if (Number.isFinite(settings.goal)) {
    const goalLabel = `Goal ${formatNumber(settings.goal, units, fmt)}`;
    layers.push({
      data: { values: [{ goal: settings.goal }] },
      layer: [
        { mark: { type: 'rule', color: CHROME.ink2.light, strokeWidth: 1, strokeDash: [4, 3] }, encoding: { y: { field: 'goal', type: 'quantitative' } } },
        {
          mark: { type: 'text', align: 'right', baseline: 'bottom', dy: -3, x: 'width', fontSize: 11, color: CHROME.ink2.light },
          encoding: { y: { field: 'goal', type: 'quantitative' }, text: { value: goalLabel } }
        }
      ]
    });
  }

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    usermeta: { colors },
    width, height,
    autosize: { type: 'fit', contains: 'padding' },
    padding: { top: 20, right: 24, bottom: 16, left: 20 },
    background: CHROME.surface.light,
    title: {
      text: title, subtitle, anchor: 'start', offset: 16,
      fontSize: 18, fontWeight: 'bold', color: CHROME.ink.light,
      subtitleFontSize: 13, subtitleColor: CHROME.ink2.light, subtitlePadding: 6
    },
    data: { values: points },
    layer: layers,
    resolve: { scale: { y: 'shared' } },
    config: {
      font: FONT,
      view: { stroke: null },
      axis: {
        labelColor: CHROME.muted.light, labelFontSize: 12, labelPadding: 6,
        titleColor: CHROME.ink2.light, titleFontSize: 12, titleFontWeight: 500,
        gridColor: CHROME.grid.light, gridWidth: 1,
        domainColor: CHROME.axis.light, tickColor: CHROME.axis.light
      },
      // Labels are measured with the server's fonts; a viewer's may be wider,
      // so the title keeps a margin.
      axisY: { domain: false, ticks: false, labelPadding: 8, titlePadding: 14 },
      axisX: { domainWidth: 1 },
      legend: {
        orient: 'top', direction: 'horizontal', title: null,
        labelColor: CHROME.ink2.light, labelFontSize: 12, symbolType: 'square', symbolSize: 120,
        offset: 4, columnPadding: 18
      }
    }
  };
}

// ---------------------------------------------------------------- dark mode

/**
 * Give an SVG written in the light palette its own dark one.
 *
 * Vega writes colors as presentation attributes (fill="#2a78d6"); a stylesheet
 * rule beats a presentation attribute, so matching on the attribute value
 * swaps every light color for its dark step without touching the markup.
 * Works wherever the SVG is shown, including as an <img>.
 */
export function addDarkMode(svg, colors = []) {
  const pairs = [
    ...Object.values(CHROME).map(c => [c.light, c.dark]),
    ...SERIES.filter(s => colors.includes(s.light)).map(s => [s.light, s.dark])
  ];
  const rules = pairs.flatMap(([light, dark]) => [
    `[fill="${light}"]{fill:${dark}}`,
    `[stroke="${light}"]{stroke:${dark}}`
  ]);
  const style = `<style>@media (prefers-color-scheme: dark){${rules.join('')}}</style>`;
  return svg.replace(/(<svg[^>]*>)/, `$1${style}`);
}

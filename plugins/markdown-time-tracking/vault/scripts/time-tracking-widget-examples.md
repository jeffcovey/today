# Time Tracking Widget Examples

The time tracking widget automatically:
- Shows timer form (start/stop) always
- Shows individual entries ONLY for single-day views
- Shows topic summary and total for all views
- Handles date ranges spanning multiple months

## Today's View (Dashboard)

```dataviewjs
await dv.view("scripts/time-tracking-widget", {
    startDate: moment().format('YYYY-MM-DD'),
    endDate: moment().format('YYYY-MM-DD')
});
```

Shows:
- Timer form
- Individual time entries table with restart buttons
- Topic summary
- Total time

## Specific Day (Daily Plan)

```dataviewjs
await dv.view("scripts/time-tracking-widget", {
    startDate: '2025-11-01',
    endDate: '2025-11-01'
});
```

Shows:
- Timer form (can start timer from any day's plan)
- Individual time entries for that specific day
- Topic summary
- Total time

## This Week (Weekly Plan)

```dataviewjs
// Calculate week start (Monday)
const today = moment();
const weekStart = today.clone().startOf('isoWeek');
const weekEnd = weekStart.clone().add(6, 'days');

await dv.view("scripts/time-tracking-widget", {
    startDate: weekStart.format('YYYY-MM-DD'),
    endDate: weekEnd.format('YYYY-MM-DD')
});
```

Shows:
- Timer form
- Topic summary (NO individual entries since it's multi-day)
- Total time

## This Month (Monthly Plan)

```dataviewjs
const monthStart = moment().startOf('month').format('YYYY-MM-DD');
const monthEnd = moment().endOf('month').format('YYYY-MM-DD');

await dv.view("scripts/time-tracking-widget", {
    startDate: monthStart,
    endDate: monthEnd
});
```

Shows:
- Timer form
- Topic summary (NO individual entries)
- Total time

## Custom Date Range

```dataviewjs
await dv.view("scripts/time-tracking-widget", {
    startDate: '2025-10-27',
    endDate: '2025-11-02'
});
```

Shows:
- Timer form
- Topic summary (NO individual entries since it spans multiple days)
- Total time

## No Parameters (Defaults to Today)

```dataviewjs
await dv.view("scripts/time-tracking-widget", {});
```

Same as today's view.

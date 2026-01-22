---
week_number: {{WEEK_NUMBER}}
start_date: {{START_DATE}}
end_date: {{END_DATE}}
week_theme:
week_priorities:
  -
  -
  -
week_summary:
cssclasses: plan
---

# Week {{WEEK_NUMBER}} – {{DATE_RANGE}}{{YEAR_SUFFIX}}

```dataviewjs
await dv.view("scripts/plans-widget", { type: "navigation" });
```

## 💡 Plan

### Theme and Priorities

`=this.week_theme`

```dataview
LIST WITHOUT ID item
FLATTEN this.week_priorities AS item
WHERE file = this.file
```

### Notes

...

---


## 🔍 Review (End of Week)


### Week Summary

`=this.week_summary`

### Daily Summaries

```dataviewjs
await dv.view("scripts/plans-widget", { type: "daily-links", startDate: dv.current().start_date, weekNum: dv.current().week_number });
```

### Projects Progress

```dataviewjs
await dv.view("scripts/plans-widget", { type: "projects", startDate: dv.current().start_date });
```

### ⏱️ Time Tracking

```dataviewjs
const page = dv.current();
const startDate = new Date(page.start_date);
const endDate = new Date(page.end_date || startDate);
if (!page.end_date) {
  endDate.setDate(endDate.getDate() + 6);
}
await dv.view("scripts/time-tracking-widget", {
  startDate: page.start_date,
  endDate: endDate.toISOString().split('T')[0]
});
```

---

### 💭 Reflection & Insights

...

---

*Week {{WEEK_NUMBER}} of {{YEAR}} | {{QUARTER}} - {{MONTH_NAME}}*

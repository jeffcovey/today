---
month_name: {{MONTH_NAME}}
year: {{YEAR}}
quarter: {{QUARTER}}
start_date: {{START_DATE}}
end_date: {{END_DATE}}
month_theme:
month_goals:
  -
  -
  -
month_summary:
cssclasses: plan
---

# {{MONTH_NAME}} {{YEAR}}

```dataviewjs
await dv.view("scripts/plans-widget", { type: "navigation" });
```

## 💡 Plan

### Theme and Goals

`=this.month_theme`

```dataview
LIST WITHOUT ID item
FLATTEN this.month_goals AS item
WHERE file = this.file
```

### Notes

...

---

## 🔍 Review (End of Month)

### Month Summary

`=this.month_summary`

### Weekly Summaries

```dataviewjs
await dv.view("scripts/plans-widget", { type: "weekly-summaries" });
```

### ⏱️ Time Tracking

```dataviewjs
const page = dv.current();
await dv.view("scripts/time-tracking-widget", {
  startDate: page.start_date,
  endDate: page.end_date
});
```

---

### 💭 Reflection & Insights

...

---

*{{MONTH_NAME}} {{YEAR}} | {{QUARTER}}*

---
quarter: {{QUARTER}}
year: {{YEAR}}
start_date: {{START_DATE}}
end_date: {{END_DATE}}
quarter_theme:
quarter_goals:
  -
  -
  -
quarter_summary:
cssclasses: plan
---

# {{QUARTER}} {{YEAR}}

```dataviewjs
await dv.view("scripts/plans-widget", { type: "navigation" });
```

## 💡 Plan

### Theme and Goals

`=this.quarter_theme`

```dataview
LIST WITHOUT ID item
FLATTEN this.quarter_goals AS item
WHERE file = this.file
```

### Key Focus Areas

...

---

## 🔍 Review (End of Quarter)

### Quarter Summary

`=this.quarter_summary`

### Monthly Summaries

```dataviewjs
await dv.view("scripts/plans-widget", { type: "monthly-summaries" });
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

*{{QUARTER}} {{YEAR}} ({{QUARTER_MONTHS}})*

---
week_number: {{WEEK_NUMBER}}
start_date: {{START_DATE}}
week_priorities:
week_summary:
review_date:
cssclasses: plan
---

```dataviewjs
await dv.view("scripts/weekly-header", { startDate: dv.current().start_date, weekNum: dv.current().week_number });
```

<!-- WEEK_META -->
**Priorities:** `=this.week_priorities`
**Review Date:** `=this.review_date`
<!-- /WEEK_META -->

---

## 📊 Week at a Glance

> [!summary] Week Summary
> `=this.week_summary`

```dataviewjs
await dv.view("scripts/weekly-daily-links", { startDate: dv.current().start_date, weekNum: dv.current().week_number });
```

---

### ⏱️ Time Tracking

```dataviewjs
const page = dv.current();
const startDate = new Date(page.start_date);
const endDate = new Date(startDate);
endDate.setDate(endDate.getDate() + 6);
await dv.view("scripts/time-tracking-widget", {
  startDate: page.start_date,
  endDate: endDate.toISOString().split('T')[0]
});
```

---

## 🎯 What Happened

<!-- ACCOMPLISHMENTS -->

### Progress 🧗

```dataviewjs
await dv.view("scripts/weekly-progress", { startDate: dv.current().start_date });
```

### Challenges ⚠️

```dataviewjs
await dv.view("scripts/weekly-concerns", { startDate: dv.current().start_date });
```


### Projects 🚀

```dataviewjs
await dv.view("scripts/weekly-projects", { startDate: dv.current().start_date });
```

<!-- /ACCOMPLISHMENTS -->

---

## 📈 Progress on Priorities

<!-- PRIORITIES_REVIEW -->

```dataviewjs
await dv.view("scripts/weekly-previous-priorities", { weekNum: dv.current().week_number, startDate: dv.current().start_date });
```

*How did it go?*

### ✅ Completed

-

### 🔄 In Progress

-

### ⏸️ Deferred

- *Why deferred?*

### ❌ Dropped

- *Why dropped? Was it the right call?*
<!-- /PRIORITIES_REVIEW -->

---

## 💭 Week Reflection

<!-- REFLECTION -->
### What Went Well

*Patterns of success*


### What Could Improve

*Patterns of struggle*

### Surprises & Insights 💡

*Unexpected events, learnings, or realizations*

### Energy & Health

*How did you feel this week? Physical, mental, emotional*


### Key Lesson

*One main takeaway from this week*

<!-- /REFLECTION -->

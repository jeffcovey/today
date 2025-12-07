---
title: Projects Dashboard
created: 2025-01-01
---

# Projects Dashboard

## Projects Needing Review

```dataviewjs
const today = dv.date('today');
const weekAgo = today.minus({days: 7});
const projects = dv.pages('"projects"')
  .where(p => p.status === "active" && (!p.last_reviewed || dv.date(p.last_reviewed) < weekAgo))
  .sort(p => p.last_reviewed || "1900-01-01", 'asc');

dv.table(
  ["Project", "Last Review", "Frequency", "Priority"],
  projects.map(p => [
    dv.fileLink(p.file.path, false, p.title),
    p.last_reviewed,
    p.review_frequency,
    p.priority
  ])
);
```

## Project Progress

```dataviewjs
const projects = dv.pages('"projects"')
  .where(p => p.status === "active" || p.status === "in_progress")
  .where(p => p.percent_done !== undefined)
  .sort(p => -p.percent_done);

dv.table(
  ["Project", "Progress", "Status"],
  projects.map(p => {
    const percent = p.percent_done || 0;
    const filled = Math.floor(percent / 5);
    const empty = 20 - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    return [
      dv.fileLink(p.file.path, false, p.title),
      `${bar} ${percent}%`,
      p.status
    ];
  })
);
```

## High & Urgent Priority

```dataviewjs
const projects = dv.pages('"projects"')
  .where(p => (p.priority === "high" || p.priority === "urgent") && p.status !== "completed")
  .sort(p => p.priority === "urgent" ? 2 : 1, 'desc')
  .sort(p => p.status, 'asc');

dv.table(
  ["Project", "Status", "Category", "Target", "Review"],
  projects.map(p => [
    dv.fileLink(p.file.path, false, p.title),
    p.status,
    p.category,
    p.target_date,
    p.review_frequency
  ])
);
```

> [!info]- Active Projects by Priority
>
> ```dataviewjs
> const projects = dv.pages('"projects"')
>   .where(p => p.status === "active")
>   .sort(p => p.priority === "urgent" ? 3 : p.priority === "high" ? 2 : p.priority === "medium" ? 1 : 0, 'desc')
>   .sort(p => p.target_date, 'asc');
>
> dv.table(
>   ["Project", "Priority", "Category", "Target", "Last Review"],
>   projects.map(p => [
>     dv.fileLink(p.file.path, false, p.title),
>     p.priority,
>     p.category,
>     p.target_date,
>     p.last_reviewed
>   ])
> );
> ```

> [!info]- Projects by Status
>
> ```dataviewjs
> const projects = dv.pages('"projects"')
>   .where(p => p.file.name !== "projects-dashboard")
>   .sort(p => p.status, 'asc')
>   .sort(p => p.priority === "urgent" ? 3 : p.priority === "high" ? 2 : p.priority === "medium" ? 1 : 0, 'desc');
>
> dv.table(
>   ["Project", "Status", "Priority", "Category", "Started"],
>   projects.map(p => [
>     dv.fileLink(p.file.path, false, p.title),
>     p.status,
>     p.priority,
>     p.category,
>     p.start_date
>   ])
> );
> ```

> [!info]- Planning Stage Projects
>
> ```dataviewjs
> const projects = dv.pages('"projects"')
>   .where(p => p.status === "planning")
>   .sort(p => p.priority === "urgent" ? 3 : p.priority === "high" ? 2 : p.priority === "medium" ? 1 : 0, 'desc');
>
> if (projects.length > 0) {
>   dv.list(projects.map(p => dv.fileLink(p.file.path, false, p.title)));
> } else {
>   dv.paragraph("No projects in planning stage");
> }
> ```

> [!info]- Completed Projects
>
> ```dataviewjs
> const projects = dv.pages('"projects"')
>   .where(p => p.status === "completed")
>   .sort(p => p.completion_date, 'desc');
>
> dv.table(
>   ["Project", "Completed", "Category", "Location"],
>   projects.map(p => [
>     dv.fileLink(p.file.path, false, p.title),
>     p.completion_date || p.end_date || "-",
>     p.category,
>     p.location || "-"
>   ])
> );
> ```

## Quick Stats

- **Total Active Projects:** `$= dv.pages('"projects"').where(p => p.status == "active").length`
- **Planning Projects:** `$= dv.pages('"projects"').where(p => p.status == "planning").length`
- **Completed Projects:** `$= dv.pages('"projects"').where(p => p.status == "completed").length`
- **High Priority:** `$= dv.pages('"projects"').where(p => p.priority == "high" || p.priority == "urgent").length`

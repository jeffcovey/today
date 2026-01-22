---
year: {{YEAR}}
start_date: {{START_DATE}}
end_date: {{END_DATE}}
year_theme:
year_goals:
  -
  -
  -
year_summary:
cssclasses: plan
---

# {{YEAR}} Annual Plan

```dataviewjs
await dv.view("scripts/plans-widget", { type: "navigation" });
```

## 💡 Plan

### Theme and Vision

`=this.year_theme`

### Annual Goals

```dataview
LIST WITHOUT ID item
FLATTEN this.year_goals AS item
WHERE file = this.file
```

---

## 🔍 Review (End of Year)

### Year Summary

`=this.year_summary`

### Quarterly Summaries

```dataviewjs
const page = dv.current();
const year = page.year;

// Find all quarterly plans for this year
const quarterlyPlans = dv.pages('"plans"')
  .where(p => {
    // Quarterly plans match pattern YYYY_Q#_00
    if (!p.file.name.match(/^\d{4}_Q\d_00$/)) return false;
    return p.year === year;
  })
  .sort(p => p.quarter, 'asc');

if (quarterlyPlans.length === 0) {
  dv.paragraph("*No quarterly plans found for this year.*");
} else {
  for (const quarter of quarterlyPlans) {
    const container = dv.el('div', '', {
      attr: { style: 'background: var(--background-secondary); border-radius: 8px; padding: 12px 16px; margin-bottom: 12px; border-left: 4px solid var(--color-orange);' }
    });

    const header = dv.el('div', '', { container });
    dv.el('a', quarter.quarter || quarter.file.name, {
      container: header,
      attr: { href: quarter.file.path, class: 'internal-link', style: 'font-weight: bold;' }
    });

    if (quarter.quarter_summary) {
      dv.el('p', quarter.quarter_summary, {
        container,
        attr: { style: 'margin: 8px 0 0 0; color: var(--text-normal);' }
      });
    }
  }
}
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

### 💭 Annual Reflection

**Major accomplishments**

...

**Challenges overcome**

...

**Key learnings**

...

**What to carry forward**

...

---

*{{YEAR}} Annual Plan*

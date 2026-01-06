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
review_date:
cssclasses: plan
---

```dataviewjs
await dv.view("scripts/weekly-header", { startDate: dv.current().start_date, weekNum: dv.current().week_number });
```

[[plans/{{PREV_WEEK}}|← Previous]] <span style="float: right;">[[plans/{{NEXT_WEEK}}|Next →]]</span>

## Week Theme: `=this.week_theme`

<!-- WEEK_META -->
**Week Priorities:**

```dataview
LIST this.week_priorities
WHERE file = this.file
```

**Review Date:** `=this.review_date`
<!-- /WEEK_META -->

---

## 📋 Week Overview

> [!summary] Week Summary
> `=this.week_summary`

```dataviewjs
await dv.view("scripts/weekly-daily-links", { startDate: dv.current().start_date, weekNum: dv.current().week_number });
```

---

## 🎯 Key Objectives for This Week

### High Priority (Must Complete)

- [ ]
- [ ]
- [ ]

### Medium Priority (Should Complete)

- [ ]
- [ ]
- [ ]

### Low Priority (Could Complete)

- [ ]
- [ ]

### Health & Wellness Goals

- [ ] Hip mobility routine: __/7 days target
- [ ] Zazen practice: __/14 sessions target (2x daily)
- [ ] Sleep schedule: __/7 nights on target
- [ ]

### Learning & Growth

- [ ]
- [ ]

---

## 📊 Daily Focus Areas

### Monday - {{MON_DATE}}

**Stage:** {{MON_STAGE}}
- **Key Focus:**
- **Major Tasks:**

### Tuesday - {{TUE_DATE}}

**Stage:** {{TUE_STAGE}}
- **Key Focus:**
- **Major Tasks:**

### Wednesday - {{WED_DATE}}

**Stage:** {{WED_STAGE}}
- **Key Focus:**
- **Major Tasks:**

### Thursday - {{THU_DATE}}

**Stage:** {{THU_STAGE}}
- **Key Focus:**
- **Major Tasks:**

### Friday - {{FRI_DATE}}

**Stage:** {{FRI_STAGE}}
- **Key Focus:**
- **Major Tasks:**

### Saturday - {{SAT_DATE}}

**Stage:** {{SAT_STAGE}}
- **Key Focus:**
- **Major Tasks:**

### Sunday - {{SUN_DATE}}

**Stage:** {{SUN_STAGE}}
- **Key Focus:**
- **Major Tasks:**

---

## 🚀 Projects Focus

### Primary Projects (Deep Work)

1. **Project Name**
   - Objective:
   - Key milestones this week:
   - Time allocation:

2. **Project Name**
   - Objective:
   - Key milestones this week:
   - Time allocation:

### Secondary Projects (Maintenance)

-
-
-

---

## 📈 Success Metrics

### Technical Achievements Target

- [ ]
- [ ]
- [ ]

### Health & Routine Achievements Target

- [ ]
- [ ]
- [ ]

### Personal/Professional Achievements Target

- [ ]
- [ ]
- [ ]

---

## ⏱️ Time Tracking

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

## 💡 Week Planning Notes

### Potential Challenges

-
-
-

### Mitigation Strategies

-
-
-

### Week Mantra

*""*

### Notes for Future Self

-
-

---

## 🔍 Week Review (End of Week)

> [!note]- Week Review (Expand after week completion)
>
> ### ✅ What Went Well
>
> **Accomplishments:**
> -
>
> -
> -
>
> **Positive Patterns:**
> -
>
> -
>
> ```dataviewjs
> await dv.view("scripts/weekly-progress", { startDate: dv.current().start_date });
> ```
>
> ### ⚠️ Challenges & Lessons
>
> **What Could Improve:**
> -
>
> -
> -
>
> **Obstacles Encountered:**
> -
>
> -
>
> ```dataviewjs
> await dv.view("scripts/weekly-concerns", { startDate: dv.current().start_date });
> ```
>
> ### 📊 Metrics Review
>
> #### Priority Completion
>
> - **High Priority:** **/** completed (___%)
> - **Medium Priority:** **/** completed (___%)
> - **Low Priority:** **/** completed (___%)
>
> #### Health & Wellness
>
> - **Hip mobility:** **/7 days (**_%)
> - **Zazen practice:** **/14 sessions (**_%)
> - **Sleep schedule:** **/7 nights (**_%)
>
> #### Projects Progress
>
> ```dataviewjs
> await dv.view("scripts/weekly-projects", { startDate: dv.current().start_date });
> ```
>
> ### 💭 Reflection & Insights
>
> **Surprises & Unexpected Events:**
> -
>
> -
>
> **Energy & Health This Week:**
> - Physical:
> - Mental:
> - Emotional:
>
> **Key Lesson/Insight:**
>
>
> **Action Items for Next Week:**
> - [ ]
> - [ ]
> - [ ]
>
> **Review Completed:** {{DATE}}

---

*Week {{WEEK_NUMBER}} of {{YEAR}} | {{QUARTER}} - {{MONTH_NAME}}*

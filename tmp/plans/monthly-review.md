---
year: {{YEAR}}
quarter: {{QUARTER}}
month: {{MONTH_NUM}}
month_name: {{MONTH}}
month_start: {{MONTH_START}}
month_end: {{MONTH_END}}
monthly_theme: {{MONTHLY_THEME}}
review_date: {{REVIEW_DATE}}
total_days: {{TOTAL_DAYS}}
total_weeks: {{TOTAL_WEEKS}}
days_count: {{DAYS_COUNT}}
weeks_reviewed: {{WEEKS_REVIEWED}}
completed_tasks: {{COMPLETED_TASKS}}
front_pct: {{FRONT_PCT}}
back_pct: {{BACK_PCT}}
off_pct: {{OFF_PCT}}
top_1: {{TOP_1}}
top_2: {{TOP_2}}
top_3: {{TOP_3}}
count_1: {{COUNT_1}}
count_2: {{COUNT_2}}
count_3: {{COUNT_3}}
target_front: {{TARGET_FRONT}}
target_back: {{TARGET_BACK}}
target_off: {{TARGET_OFF}}
next_month: {{NEXT_MONTH}}
w1_file: {{W1_FILE}}
w1_num: {{W1_NUM}}
w1_dates: {{W1_DATES}}
w1_theme: {{W1_THEME}}
w2_file: {{W2_FILE}}
w2_num: {{W2_NUM}}
w2_dates: {{W2_DATES}}
w2_theme: {{W2_THEME}}
w3_file: {{W3_FILE}}
w3_num: {{W3_NUM}}
w3_dates: {{W3_DATES}}
w3_theme: {{W3_THEME}}
w4_file: {{W4_FILE}}
w4_num: {{W4_NUM}}
w4_dates: {{W4_DATES}}
w4_theme: {{W4_THEME}}
w5_file: {{W5_FILE}}
w5_num: {{W5_NUM}}
w5_dates: {{W5_DATES}}
w5_theme: {{W5_THEME}}
cssclasses: plan
---

# `=this.month_name` `=this.year` - Monthly Review & Plan

<!-- MONTH_META -->
**Period:** `=this.month_start` to `=this.month_end`
**Theme:** `=this.monthly_theme`
**Review Date:** `=this.review_date`
<!-- /MONTH_META -->

---

## 📊 Month at a Glance

<!-- MONTH_STATS: Auto-generated -->
**Days tracked:** `=this.days_count`/`=this.total_days`
**Weeks reviewed:** `=this.weeks_reviewed`/`=this.total_weeks`
**Tasks completed:** `=this.completed_tasks`
**Stage balance:** Front `=this.front_pct`% | Back `=this.back_pct`% | Off `=this.off_pct`%
**Most active topics:** #`=this.top_1` (`=this.count_1`) #`=this.top_2` (`=this.count_2`) #`=this.top_3` (`=this.count_3`)
<!-- /MONTH_STATS -->

---

## 🎯 Major Accomplishments

<!-- ACCOMPLISHMENTS -->
### Victories 🎉

*What made you proud this month?*


### Projects Completed ✅

*What did you finish?*


### New Initiatives Started 🚀

*What new things began?*


### Skills Developed 📚

*What did you learn or improve?*
<!-- /ACCOMPLISHMENTS -->

---

## 🚧 Challenges & Learnings

<!-- CHALLENGES -->
### Major Obstacles

*What were the biggest challenges?*


### How You Adapted

*How did you respond to challenges?*


### Lessons Learned

*What will you do differently?*


### Support Received

*Who or what helped?*
<!-- /CHALLENGES -->

---

## 💰 Financial Check-In

<!-- FINANCIAL -->
### Income

**Target:**
**Actual:**
**Variance:**

### Expenses

**Planned:**
**Actual:**
**Variance:**

### Savings & Investments

### Financial Wins


### Areas to Improve

<!-- /FINANCIAL -->

---

## ❤️ Health & Wellness

<!-- HEALTH -->
### Physical Health

**Exercise:**
**Sleep:**
**Nutrition:**

### Mental Health

**Stress level:**
**Mindfulness:**
**Energy:**

### Emotional Wellbeing


### Health Goals Progress

<!-- /HEALTH -->

---

## 👥 Relationships & Social

<!-- SOCIAL -->
### Quality Time

*Who did you spend meaningful time with?*


### Relationship Highlights


### Social Events


### People to Reconnect With


### Gratitude

*Who are you grateful for?*
<!-- /SOCIAL -->

---

## 📈 Monthly Goals Review

<!-- GOALS_REVIEW -->
*Review the goals you set at month start*

### Goals Set

1.
2.
3.
4.
5.

### Achievement Status

- **Completed:**
- **In progress:**
- **Deferred:**
- **Abandoned:**

### Why Goals Changed

*Did priorities shift?*


### Unexpected Wins

*What good things happened that weren't planned?*
<!-- /GOALS_REVIEW -->

---

## 💭 Month Reflection

<!-- REFLECTION -->
### This Month's Story

*What was the narrative arc?*


### Most Significant Moment


### Best Decision Made


### Energy Assessment

*Was your pace sustainable?*


### Values Alignment

*Did actions match your values?*


### One Word for This Month

<!-- /REFLECTION -->

---

## 📅 Weekly Breakdown

<!-- WEEK_LINKS -->
```dataviewjs
const weeks = [
  { file: dv.current().w1_file, num: dv.current().w1_num, dates: dv.current().w1_dates, theme: dv.current().w1_theme },
  { file: dv.current().w2_file, num: dv.current().w2_num, dates: dv.current().w2_dates, theme: dv.current().w2_theme },
  { file: dv.current().w3_file, num: dv.current().w3_num, dates: dv.current().w3_dates, theme: dv.current().w3_theme },
  { file: dv.current().w4_file, num: dv.current().w4_num, dates: dv.current().w4_dates, theme: dv.current().w4_theme },
  { file: dv.current().w5_file, num: dv.current().w5_num, dates: dv.current().w5_dates, theme: dv.current().w5_theme }
];

for (const week of weeks) {
  if (week.file) {
    dv.paragraph(`- [[${week.file}|Week ${week.num} (${week.dates})]] - ${week.theme || ''}`);
  }
}
```
<!-- /WEEK_LINKS -->

---

## 🎯 Next Month's Plan

<!-- NEXT_MONTH_PLAN -->
### Monthly Theme

*What's the overarching focus for `=this.next_month`?*


### Top 5 Goals

1.
2.
3.
4.
5.

### Projects to Complete


### Projects to Start


### Habits to Build/Maintain


### Financial Targets

**Income goal:**
**Savings goal:**
**Key expenses:**

### Health & Wellness Goals

**Physical:**
**Mental:**
**Emotional:**

### Relationship Intentions


### Stage Day Balance


*How will you balance your time?*
- **Target Front Stage days:** `=this.target_front`
- **Target Back Stage days:** `=this.target_back`
- **Target Off Stage days:** `=this.target_off`

### Success Criteria

*How will you know this was a successful month?*
-

-
<!-- /NEXT_MONTH_PLAN -->

---

## ⏱️ Time Tracking - Month

```dataviewjs
await dv.view("scripts/time-tracking-widget", {
  startDate: dv.current().month_start,
  endDate: dv.current().month_end
});
```

---

*Created: `=this.file.ctime`*
*Reviewed: `=this.review_date`*

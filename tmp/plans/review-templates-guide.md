# Review Templates Guide

## 📋 Available Templates

All templates are located in `vault/templates/`:

1. **daily-plan.md** - Daily planning template (existing)
2. **weekly-review.md** - Weekly review & planning (NEW)
3. **monthly-review.md** - Monthly review & planning (NEW)
4. **quarterly-review.md** - Quarterly review & planning (NEW)
5. **annual-review.md** - Annual review & planning (NEW)

---

## 🎯 When to Use Each Template

### Weekly Review (`weekly-review.md`)

- **When:** Every Sunday evening
- **Time:** 30-45 minutes
- **Purpose:** Close one week, open the next
- **Focus:** Tactical - what happened, what's next
- **File naming:** `YYYY_Q#_MM_W##_00.md` (e.g., `2025_Q4_12_W49_00.md`)

### Monthly Review (`monthly-review.md`)

- **When:** Last day or first day of month
- **Time:** 1-2 hours
- **Purpose:** See patterns, adjust course
- **Focus:** Strategic - trends, priorities, alignment
- **File naming:** `YYYY_Q#_MM_00.md` (e.g., `2025_Q4_12_00.md`)

### Quarterly Review (`quarterly-review.md`)

- **When:** Last week of quarter
- **Time:** 2-4 hours
- **Purpose:** Major reflection and planning
- **Focus:** Transformational - growth, learning, direction
- **File naming:** `YYYY_Q#_00.md` (e.g., `2025_Q4_00.md`)

### Annual Review (`annual-review.md`)

- **When:** Dec 26-31
- **Time:** Full day or weekend
- **Purpose:** Life assessment and vision setting
- **Focus:** Existential - purpose, values, legacy
- **File naming:** `YYYY_00.md` (e.g., `2025_00.md`)

---

## 🔧 How to Use

### Creating a Review File

1. **Copy the template:**

   ```bash
   cp vault/templates/weekly-review.md vault/plans/2025_Q4_12_W49_00.md
   ```

2. **Replace placeholders:**
   - `{{WEEK_NUMBER}}` → Actual week number
   - `{{START_DATE}}` → YYYY-MM-DD format
   - `{{MONTH}}` → Month name
   - etc.

3. **Fill in the sections:**
   - Start with automated sections (stats, links)
   - Then narrative sections (accomplishments, reflections)
   - End with planning sections

### Template Structure

Each template has these types of sections:

#### HTML Comment Markers

```markdown
<!-- SECTION_NAME -->
Content here
<!-- /SECTION_NAME -->
```

- Used for programmatic manipulation
- Scripts can auto-populate or clean these sections
- Leave markers in place even if manual content

#### Auto-generated Sections

Marked with comment "Auto-generated" - these can be populated by scripts:
- Stats (task counts, stage balance)
- Links to sub-period files
- Topic analysis
- Time tracking widgets

#### Manual Narrative Sections

Require your reflection and writing:
- Accomplishments
- Challenges
- Reflections
- Plans

---

## 📊 Progressive Detail Levels

### Weekly → Monthly → Quarterly → Annual

Each level up increases:
- **Scope:** More time covered
- **Depth:** Deeper reflection
- **Strategy:** More long-term thinking
- **Philosophy:** More existential questions

### Key Questions at Each Level

**Weekly:** What happened? What's next?
**Monthly:** What patterns? What's working/not?
**Quarterly:** Who am I becoming? What matters?
**Annual:** What's my purpose? Am I living it?

---

## 🤖 Automation Opportunities

These sections can be auto-generated from daily plans:

### Weekly Reviews

- Days count (7 daily plan files)
- Tasks completed (sum from daily "Completed Today")
- Stage balance (count Front/Back/Off days)
- Top topics (frequency analysis from completed tasks)
- Daily links (file paths from naming convention)

### Monthly Reviews

- Days/weeks tracked
- Stage balance percentages
- Topic frequency analysis
- Week links

### Quarterly Reviews

- Days tracked
- Stage balance
- Month links

### Annual Reviews

- Full year stats
- Quarter links

---

## 💡 Best Practices

### Before You Start

1. Have all daily plans for the period complete
2. Review time tracking data
3. Block uninterrupted time
4. Get in reflective mindset

### During the Review

1. **Start with data** - Let numbers inform the narrative
2. **Be honest** - Acknowledge both wins and struggles
3. **Find patterns** - What keeps showing up?
4. **Extract lessons** - What would you tell past self?
5. **Look forward** - What will make next period great?

### After the Review

1. **Share with accountability partner** (if applicable)
2. **Set calendar reminders** for key commitments
3. **Update annual/quarterly goals** if needed
4. **Archive or summarize** if appropriate

---

## 🔄 Review Cadence

Recommended schedule:

```
Sunday Evening:    Weekly Review (30-45 min)
Last Day of Month: Monthly Review (1-2 hours)
Last Week of Q:    Quarterly Review (2-4 hours)
Dec 26-31:        Annual Review (full day)
```

### Don't Skip

- **Weekly:** Foundation of the system
- **Monthly:** Catches patterns early
- **Quarterly:** Strategic course corrections
- **Annual:** Shapes your entire year

---

## 📝 Template Customization

Feel free to:
- **Add sections** relevant to your life
- **Remove sections** that don't serve you
- **Reorder** to match your thinking process
- **Add custom markers** for automation

Keep:
- HTML comment markers (for scripts)
- Basic structure (review → reflect → plan)
- Time tracking widgets
- Links to sub-periods

---

## 🎯 Example File Locations

```
vault/plans/
├── 2025_00.md                    # Annual plan
├── 2025_Q4_00.md                 # Q4 plan
├── 2025_Q4_12_00.md              # December plan
├── 2025_Q4_12_W49_00.md          # Week 49 plan
├── 2025_Q4_12_W49_01.md          # Daily (Dec 1)
├── 2025_Q4_12_W49_02.md          # Daily (Dec 2)
└── 2025_Q4_12_W49_03.md          # Daily (Dec 3)
```

Notice the `_00` pattern for review files vs. `_DD` for daily plans.

---

## 🚀 Getting Started

### This Week

1. Create your first weekly review for Week 49
2. Use the template to review Mon-Sun this week
3. Plan next week with the forward-looking section

### This Month

1. At month end (Dec 31), create December monthly review
2. Use it to review all of December
3. Set intentions for January

### This Quarter

1. Before Jan 1, create Q4 quarterly review
2. Review Oct, Nov, Dec as a whole
3. Set Q1 2026 themes and goals

### This Year

1. Between Dec 26-31, create 2025 annual review
2. Reflect on the full year
3. Set vision for 2026

---

*Created: December 3, 2025*
*All templates include HTML markers for future automation*

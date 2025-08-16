# Notion to Today Migration Project

## Project Overview
Migrate historical planning and review data from Notion databases to the new Today system's `plans/` directory structure.

**Status:** Active
**Start Date:** 2025-08-16
**Target Completion:** TBD

## Scope
- Years covered: 2022-2025
- Data types: Years, Quarters, Months, Weeks, Days
- Source: Notion databases
- Destination: `plans/` directory with YYYY-QQ-MM-DD naming scheme

## Phase 1: Discovery & Analysis
- [ ] Inventory Notion databases and their structures
- [ ] Document field mappings (Notion → Today format)
- [ ] Identify data export options from Notion
- [ ] Estimate volume of content to migrate
- [ ] Determine what historical data is worth preserving

## Phase 2: Migration Strategy
- [ ] Design migration scripts/tools
- [ ] Create templates for different plan levels
- [ ] Define how to handle Notion-specific features (databases, relations, etc.)
- [ ] Plan for handling attachments/images
- [ ] Decide on incremental vs. bulk migration approach

## Phase 3: Implementation
- [ ] Export Notion data (CSV, Markdown, or API)
- [ ] Build conversion scripts for each plan level
- [ ] Create year files (2022.md, 2023.md, 2024.md)
- [ ] Create quarter files for each year
- [ ] Create month files as needed
- [ ] Create week files where valuable
- [ ] Import daily reviews/plans

## Phase 4: Validation & Cleanup
- [ ] Verify data integrity after migration
- [ ] Cross-reference important dates and milestones
- [ ] Clean up formatting issues
- [ ] Add cross-links between related plans
- [ ] Archive original Notion exports

## Technical Considerations

### Notion Data Structure
- **Years Database**: Annual goals, themes, milestones
- **Quarters Database**: Quarterly objectives, OKRs
- **Months Database**: Monthly plans, reviews
- **Weeks Database**: Weekly planning, retrospectives
- **Days Database**: Daily logs, task lists

### Today File Structure
```
plans/
├── 2022.md
├── 2022-Q1.md
├── 2022-Q1-01.md
├── 2022-Q1-01-W01.md
├── 2022-Q1-01-01.md
└── ... (continuing pattern)
```

### Migration Mapping
| Notion Field | Today Section | Notes |
|-------------|---------------|-------|
| Title | # Header | |
| Date | Filename component | |
| Goals | ## Objectives | Convert to checkbox format |
| Notes | ## Notes | Preserve markdown |
| Completed | ## Completed | Move completed items |
| Tags | Consider categories | May need new approach |

## Questions to Resolve
1. How far back should we migrate? (All of 2022-2024 or just highlights?)
2. Should we preserve all daily logs or just significant ones?
3. How to handle Notion relations and rollups?
4. What about embedded files and images?
5. Should we maintain URL references back to Notion?

## Resources
- [ ] Notion API documentation
- [ ] Notion export guide
- [ ] Create backup of Notion workspace before migration
- [ ] Test migration with small dataset first

## Success Criteria
- All valuable historical planning data accessible in Today
- Consistent formatting across all migrated files
- Ability to reference past plans for patterns and learnings
- Clean deprecation of Notion for planning purposes

## Notes
- Consider keeping Notion read-only for reference during transition
- May want to migrate in reverse chronological order (newest first)
- Could start with just 2024-2025 as proof of concept

## Next Steps
1. Export a sample quarter from Notion to understand data structure
2. Create a prototype conversion script
3. Test with Q1 2024 data
4. Iterate and refine process
5. Execute full migration

---
Created: 2025-08-16
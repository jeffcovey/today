# Notion to Today Migration Project
<!-- project-id: 814d87fa19132e904cd842d89128c870 -->

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

- [ ] Inventory Notion databases and their structures <!-- task-id: 22c5543e2523ea87140aa22b1561194d -->
- [ ] Document field mappings (Notion → Today format) <!-- task-id: 68fb34306f98f023a2ae40576d90d887 -->
- [ ] Identify data export options from Notion <!-- task-id: 22c67a98c8c8917d9e949ce79744f3cf -->
- [ ] Estimate volume of content to migrate <!-- task-id: d00e324d8748256117c7d455b6dddb9f -->
- [ ] Determine what historical data is worth preserving <!-- task-id: 2c39a0d9303c7f4da92e566cadb82b0c -->

## Phase 2: Migration Strategy

- [ ] Design migration scripts/tools <!-- task-id: 1b62c0cc1cefb4c13e9bf485e8cfff08 -->
- [ ] Create templates for different plan levels <!-- task-id: 168145bbf22ccf043f582222177b70b3 -->
- [ ] Define how to handle Notion-specific features (databases, relations, etc.) <!-- task-id: 200ffc2eb29ce206742243918b0a1d65 -->
- [ ] Plan for handling attachments/images <!-- task-id: 1cf79f50867acfda7e5edf7838528eb8 -->
- [ ] Decide on incremental vs. bulk migration approach <!-- task-id: f5d39a27fcf9cddb46c3b9215e659915 -->
- [ ] Decide where to migrate Notion Action Items assigned to other people (probably just Mehul Trivedi now) <!-- task-id: ed0d03dc1c1e57672ebf95e470740702 -->

## Phase 3: Implementation

> **⚠️ REMINDER**: Notion sync has been temporarily restored in `bin/sync` (line 78) to support importing Action Items. Remove this line after all Action Items have been imported to complete the migration away from Notion.
> 
> **⚠️ REMINDER**: `bin/notion daily --all` has been added to Fly scheduler (src/scheduler.js line 70-74) to maintain Notion automation during migration. Remove this scheduled job after completing the migration away from Notion. The temporal creation (days/weeks/months/quarters/years) has been disabled in src/temporal-manager.js.

- [ ] Export Notion data (CSV, Markdown, or API) <!-- task-id: 5db6a2e3df980e98f1f92dc0bceb4622 -->
- [ ] Build conversion scripts for each plan level <!-- task-id: 797b3634044f342ea4e7d91cce20d086 -->
- [ ] Create year files (2022.md, 2023.md, 2024.md) <!-- task-id: 38a9146aa919c6e70c649adb6fdad5f2 -->
- [ ] Create quarter files for each year <!-- task-id: 83de8368ccdb0df812bbf0cb5dcf8c44 -->
- [ ] Create month files as needed <!-- task-id: 9b40a3e0afe0fc38ecbe4e7ca37b06c3 -->
- [ ] Create week files where valuable <!-- task-id: fd637eddbce6550ab527d6978a7a8369 -->
- [ ] Import daily reviews/plans <!-- task-id: 8dc6cb8490ef76a5ab950914cf68704b -->

## Phase 4: Validation & Cleanup

- [ ] Verify data integrity after migration <!-- task-id: 56312a1927113a48a3b8177c9a2345c7 -->
- [ ] Cross-reference important dates and milestones <!-- task-id: a47680e77275a1f76a562360e6cbc80e -->
- [ ] Clean up formatting issues <!-- task-id: a7683b498547c2b1d8979896aef7382e -->
- [ ] Add cross-links between related plans <!-- task-id: 24628bc21f83b3cb6ec717adfdaec85b -->
- [ ] Archive original Notion exports <!-- task-id: 68aeaef4c17c6ded82088c1a87d6a18a -->

## Phase 5: Database Optimization

- [ ] **Optimize markdown_sync table** - Currently sending 4,490 rows to Turso with duplicate paths <!-- task-id: f51819349d02c60baac25eb1d8c34787 -->
  - Clean up old file paths from vault restructuring (notes/tasks/ → vault/notes/tasks/)
  - Remove entries for files that no longer exist
  - Batch updates instead of individual writes
  - Only update timestamps when tasks actually change
  - Consider implementing incremental sync strategy

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

- [ ] Notion API documentation <!-- task-id: 4529d1b7a2012f2504d1af5aa8a35ef0 -->
- [ ] Notion export guide <!-- task-id: 0e136c0b1afc7ce37137ffbad1a368df -->
- [ ] Create backup of Notion workspace before migration <!-- task-id: f6b824cbd0fb78d8c6aed9954ffc7f2a -->
- [ ] Test migration with small dataset first <!-- task-id: 0712d4597f7b9b44b7b0dd785a55d49c -->

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

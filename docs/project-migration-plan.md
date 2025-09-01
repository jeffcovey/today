# Notion Projects to Vault Migration Plan

## Project Markdown Format Design

### File Naming Convention

- Filename: `{project-title-slug}.md`
- Examples:
  - `treat-arthritis.md`
  - `palm-springs-2025.md`
  - `ogm-social-media-monitoring.md`

### Markdown Structure

```markdown
# {Project Title}
<!-- notion-id: {notion-page-id} -->

## Overview
**Status:** {Status}
**Priority:** {derived from status if applicable}
**Created:** {created_time}
**Last Updated:** {last_edited_time}
**Timeline:** {Timeline Dates if present}
**Review Date:** {Review Date if present}

## Description
{Text property content if present}

## Goals & Outcomes
<!-- From Outcome Goals relation -->
- [ ] Goal 1
- [ ] Goal 2

## Tasks
<!-- From Action Items relation - fetch and list -->
### Active Tasks
- [ ] Task title <!-- task-id: {notion-task-id} -->
- [ ] Another task

### Completed Tasks
- [x] Completed task

## Notes & Resources
<!-- From various relations -->
### Meeting Notes
- [Meeting note title](link-if-available)

### Documents
- [Document title](link-if-available)

### Related Projects
<!-- From Blocking/Blocked by relations -->
- Blocks: [Project Name](../project-name.md)
- Blocked by: [Other Project](../other-project.md)

## Tags
<!-- From Tags/Knowledge Vault relation -->
- #tag1
- #tag2

## Metadata
<!-- Additional Notion properties -->
- **Quarter:** Q3 2025
- **% Completed:** 77%
- **Notion URL:** {original-notion-url}
```

## Migration Strategy

### Phase 1: Active Projects

Migrate projects with these statuses first:
1. 1st Priority (2 projects)
2. 2nd Priority (2 projects)
3. 3rd Priority (2 projects)
4. 4th Priority (2 projects)
5. 5th Priority (4 projects)
6. In progress (6 projects)
7. Next Up (11 projects)

### Phase 2: Future Projects

- Future (14 projects)
- Someday/Maybe (4 projects)

### Phase 3: Historical Projects

- On Hold (2 projects)
- Completed (51 projects) - Consider archiving to `vault/projects/archive/`

## Property Mappings

| Notion Property | Markdown Section | Notes |
|-----------------|------------------|-------|
| Project (title) | # Header | Main title |
| Status | Overview > Status | Keep original status |
| Timeline Dates | Overview > Timeline | Format as readable date |
| Review Date | Overview > Review Date | Format as readable date |
| Text | Description | Rich text content |
| Action Items (Tasks) | Tasks section | Fetch related tasks via API |
| Notes & Meetings | Notes & Resources | List with links |
| Documents Vault | Notes & Resources | List with links |
| Tags/Knowledge Vault | Tags section | Convert to hashtags |
| Blocking/Blocked by | Related Projects | Internal links |
| % Tasks Completed | Metadata | Show as percentage |
| Created/Last Edited | Overview | ISO dates |

## Related Data to Fetch

For each project, we need to:
1. Fetch related Action Items to populate task list
2. Fetch related Notes & Meetings titles
3. Fetch related Documents titles
4. Fetch Tag names from Knowledge Vault
5. Fetch related Project titles for blocking relationships

## Migration Script Requirements

1. **Data Fetching**
   - Connect to Notion API
   - Fetch all projects
   - Fetch related data for each project

2. **File Generation**
   - Create markdown files in `vault/projects/`
   - Preserve Notion IDs as comments
   - Generate proper slug names

3. **Content Processing**
   - Convert Notion rich text to markdown
   - Format dates consistently
   - Generate task lists from relations
   - Create cross-references between projects

4. **Validation**
   - Check for naming conflicts
   - Verify all relations resolved
   - Ensure markdown is valid
   - Create migration report

## Example Projects to Test

1. **Treat Arthritis** - Has many relations, good test case
2. **Palm Springs 2025** - Already exists, test merge
3. **Move to MDBootstrap** - Technical project

## Success Criteria

- [ ] All active projects migrated
- [ ] Task lists populated from Action Items
- [ ] Cross-references working between projects
- [ ] Notion IDs preserved for reference
- [ ] Existing vault projects merged properly
- [ ] Migration report generated

## Next Steps

1. Build migration script
2. Test with 3 sample projects
3. Review and refine format
4. Run full migration
5. Validate results
6. Archive Notion projects database

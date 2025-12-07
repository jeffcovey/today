---
title:
cover_image:
status: planning
priority: medium
category:
start_date:
target_date:
review_frequency: weekly
last_reviewed:
cssclasses: project-template
---

# {{title}}

**Open Tasks:** `$= dv.current().file.tasks.where(t => !t.completed).length`

> [!todo]- Task List
>
> ```tasks
> not done
> path includes projects/{{title}}
> sort by happens
> sort by priority
> group by function task.file.path.toUpperCase().replace(query.file.folder, ': ')
> ```

## Overview

**Goal:**
**Status:** `=this.status`
**Priority:** `=this.priority`
**Category:** `=this.category`
**Target Date:** `=this.target_date`

## Objectives

- [ ]

## Current Status

## Next Steps

## Notes

## Related Projects

---
*Last Review: `=this.last_reviewed`*

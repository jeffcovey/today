---
obsidianUIMode: preview
---

# Tasks in plan files

> [!note] Requires [Obsidian Tasks](https://obsidian-tasks-group.github.io/obsidian-tasks/) plugin

```tasks
not done
path includes plans/
path does not include _00.md
no scheduled date
no due date
filter by function const match = task.file.filename.match(/(\d{4})_Q\d+_(\d{2})_W\d+_(\d{2})\.md/); if (!match) return false; const fileDate = new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3])); const today = new Date(); today.setHours(0, 0, 0, 0); return fileDate <= today;
group by function task.file.path.toUpperCase().replace(query.file.folder, ': ')
```

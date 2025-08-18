Syncing with Todoist has been more trouble than it's worth. Let's remove all of our Todoist code.

Then, we still need a way of tracking todos. I think we'll migrate all our tasks from Notion to here, but we need to synchronize for a while. I like the simplicity of our markdown tasks like in notes/tasks/ and projects/, but we need something richer than simple lists. We could use Taskpaper-style tags, but that clutters the view. If you look at the Action Items database in Notion, you'll see that each task has many propertie. Some I'd like to keep are:

- Do Date
- Tag
- Stage
- Project
- Repeat frequency

How would you recommend creating a flexible system that we can extend as we have new ideas? Can we put tasks in .data/today.db so we can make relations between tasks and projects, etc.? How would we then include these tasks in our Markdown files? It would be great if we had a file that automatically updates with today's tasks, project files with sections where tasks are included, etc. They would need to sync two ways through bin/sync – items completed or added in the database would have to be reflected in today's tasks, related projects, related tag summaries, etc., and items checked off in or added to a Markdown file would have to be synced to the database, then from there to everywhere else that task is represented. We would have to avoid collisions — two tasks named "Call Mary", for example, one about calling Mary Smith about an inspection and one about calling Mary Jones for her birthday. How would we do that? Metadata about task IDs in the Markdown files?

What do you think? Do you have any better ideas? Thanks!


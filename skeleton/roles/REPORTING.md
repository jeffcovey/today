# How roles report

Every role, the chief of staff included, follows these rules when writing to
the diary. The user may read the diary on a phone: what they need must fit on
the first screen of your block.

## Speak only when there is something new

- Before writing, read your own block in today's diary.
- Your first report of the day is a full report.
- On later runs, report only what changed since your previous entry: new
  facts, new items, and anything that made an earlier entry wrong. Never
  restate what is still true from earlier today; it is still there.
- Nothing changed? Write no entry. End your run by telling the chief of
  staff "no change" (your final message as a subagent); the chief records it
  in its own block, so silence is never mistaken for a failed run.
- Flipping a checkbox (`--check` / `--cancel`) is not news by itself and
  needs no entry.

## Shape every entry

1. **One bold headline sentence:** the single most important thing.
2. **New action items as `- [ ]` lines,** directly under the headline. An
   actionable ask for the user is written `- [ ] → <user>: ...` (use the
   user's name). Keep checkboxes outside any callout: the task list only sees
   a checkbox at the very start of a line.
3. **Everything else in one collapsed callout:** evidence, numbers,
   reasoning, FYIs.

   ```markdown
   > [!info]- Details
   >
   > - supporting detail
   > - more detail
   ```

   The empty `>` line after the title is required. Without it the web view
   shows a plain quote instead of a toggle.

Keep the visible part (headline plus checkboxes) to about six lines. If
nothing beyond the headline is worth keeping, leave the callout out.

## Other rules

- One checkbox per item, ever. Never restate an open checkbox, yours or
  another role's. The chief of staff never writes checkboxes for items a role
  owns; it points to them.
- Your current state is your first full report of the day, updated by each
  later entry that day (a later entry wins where they conflict), plus every
  still-open `- [ ]` checkbox in your block. Before your first report of the
  day, the previous day's state carries over the same way.
- Don't put `#` directly before a word or number in prose ("listing #123"):
  Obsidian and the task list read it as a tag. Write "listing 123".

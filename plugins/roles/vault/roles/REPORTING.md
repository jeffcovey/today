# How roles report

Every role, the chief of staff included, follows these rules when writing to
the day's plan file. The user may read it on a phone: what they need must fit
on the first screen of your block.

## Remember what was decided

- Before anything else, review the last two weeks with
  `plugins/roles/history.js <your-name> --days 14`: your own blocks and the
  chief of staff's, oldest first, with the user's reply lines where they were
  written.
- What you read there ranks in this order: the user's `->` reply lines first,
  the chief of staff's entries second, your own earlier entries last. Within
  a level, a later statement wins over an earlier one.
- A "no", a "drop this", or a decline from the user stands until the user
  reverses it. A new email about the same thing, a date drawing closer, or
  the item turning up again in a source is not new information: don't raise
  it, don't draft for it, and don't list it as still open. A cancelled
  (`[-]`) checkbox of yours was declined and counts the same way.
- When an earlier entry of yours is now wrong or outdated — its headline
  included — amend it in place: `plugins/roles/report.js <your-name> --date
  <that day> --amend <HH:MM> "<corrected text>"`. It keeps the user's replies
  and any settled checkbox in that entry and stamps the entry as amended.
  Don't let a stale entry stand, and don't restate it in a new one.

## Speak only when there is something new

- Before writing, read your own block in today's plan file.
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
  day, the previous day's state carries over the same way — and what the
  user and the chief of staff said in the last two weeks still governs it
  (see **Remember what was decided**).
- Don't put `#` directly before a word or number in prose ("listing #123"):
  Obsidian and the task list read it as a tag. Write "listing 123".

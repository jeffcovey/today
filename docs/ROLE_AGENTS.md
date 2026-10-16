# Role Agents

Role agents are standing AI helpers — a bookkeeper, a fitness coach, an
innkeeper — defined by the user in their vault and reporting into the daily
plan. They are the optional `roles` plugin (`plugins/roles/`); nothing here
runs or installs unless it is enabled. The plan file is the whole
interaction model: roles write durable report blocks at the end of the
day's plan, the user replies inline from any device, and the next run reads
the replies. The daily plan is about what to do, which is what this
back-and-forth is about; the diary stays the user's record of what
happened. Because the plans plugin already feeds the daily plan to AI
context, every `bin/today` session sees the reports for free, and past plan
files are each role's permanent memory: every run starts by reading its own
blocks and the chief of staff's from the last two weeks
(`plugins/roles/history.js <name> --days 14`), where the user's replies
outrank the chief's entries, which outrank the role's own.

Reports lived in the diary until October 2026;
`plugins/roles/migrate-diary-to-plans.js` moves existing blocks (dry run by
default, `--write` to apply), and the `markdown-diary` plugin still parses
blocks it finds in old diary files.

See [jeffcovey/today#573](https://github.com/jeffcovey/today/issues/573) for
the original design discussion.

## Role definitions

A role is a directory in the vault with an
[agentskills.io](https://agentskills.io/)-style `SKILL.md`:

```text
vault/roles/
  REPORTING.md              # how every role writes to the plan file
  _template/SKILL.md        # copy to create a new role
  chief-of-staff/SKILL.md   # the orchestrator (the only scheduled role)
  <your-role>/SKILL.md
```

The plugin ships these as vault files in `plugins/roles/vault/roles/`.
Like every plugin's vault files, `bin/plugins vault-files --install` copies
them only when the plugin is enabled and only when they are missing; `--force`
would overwrite edited copies, so don't use it once you've customized your
roles.

Every role file answers the same five sections, so roles stay comparable:

| Section | Answers |
| --- | --- |
| Owns | which sources it reads, which outcomes it watches |
| May do alone | writes it can make without asking |
| Hands to the user | what it must never decide itself |
| Run | the numbered steps of one run, ending in one report |
| Red flags | role-specific hazards |

Every role other than the chief of staff states a **Run when** line: the
events that should make the chief of staff launch it, and the longest it may
go without a report. The chief launches a role only for a reason it can name
from that line or from a reply addressed to the role; "hasn't reported today"
is not a reason. The chief is exempt from dispatch and runs only when the
plugin starts it at its run times (see **Running the staff**) or the user runs
it by hand.

## Reports for a phone screen

`roles/REPORTING.md` holds the rules every role follows when it writes:

- **New information only.** The first report of the day is complete; later
  runs report only what changed. A role with nothing new writes nothing and
  tells the chief "no change", which the chief records in its own block.
- **State carries forward.** A role's current state is its first full report
  of the day, updated by each later entry that day (a later entry wins where
  they conflict), plus every still-open `- [ ]` checkbox in its block. Before
  its first report of the day, the previous day's state carries over the same
  way.
- **Decisions stick.** Each run begins with `plugins/roles/history.js <name>
  --days 14`, which prints the role's own blocks and the chief of staff's from the last
  two weeks, oldest first, with the user's `->` replies where they were
  written. Precedence: the user's replies, then the chief of staff, then the
  role itself; within a level the later statement wins. A decline from the
  user stands until the user reverses it — a fresh email or an approaching
  date does not reopen the item. An entry that is now wrong or outdated is
  amended in place (`--amend`, below) rather than left standing or restated.
- **Headline, checkboxes, then a toggle.** One bold headline sentence, then
  any new `- [ ]` items, then everything else inside a collapsed callout
  (`> [!info]- Details`, followed by an empty `>` line, which the web view
  needs to render a toggle). Checkboxes stay outside the callout because the
  task list only sees a checkbox at the start of a line.
- **One checkbox per item.** The chief's summary lists the user's top items
  as numbered prose naming the owning role; the checkbox itself lives once,
  in that role's block.

## ROLE blocks in the daily plan

Reports live at the end of the day's plan file
(`plans/YYYY_Qn_MM_Wnn_DD.md`, after the plan's own sections) inside marker
blocks:

```markdown
<!-- ROLE:cpa:START -->
## 🤖 CPA

### 14:05

**Status:** OK

Categorized 12 transactions.

→ Jeff: approve the money-market transfer?
<!-- ROLE:cpa:END -->
```

The block format lives in `src/diary-role-blocks.js`, shared by the plugins
that read blocks and the roles plugin, which writes them. Properties:

- **Durable.** The plans plugin's end-of-day maintenance (removing the
  due-today query, dating the completed-tasks query, adding the summary
  callout, filling tomorrow's focus) rewrites sections above the blocks and
  never touches them; those rewrites are compare-and-swap, so a role report
  landing in the same file at the same moment is not lost.
- **In context.** A day plan's `## 🤖 <Role>` sections reach the planning
  context as `**Staff — <Role>:**` with their headline, open asks, and the
  user's replies (the details callouts are dropped with other blockquotes).
  Role entries are not diary rows and don't appear in `bin/diary` output;
  `plugins/roles/history.js` reads them from the plan files.
- **Append-only, with two guarded exceptions.** New entries are inserted
  before the END marker, and what the user writes inside a block is never
  rewritten, so their replies survive every later report. A role may flip
  the state of one of its own checkboxes, and may amend one of its own
  entries with `--amend` (below), which keeps the user's replies and settled
  checkboxes in that entry untouched.

Replies use routing lines: `-> cpa: yes, do it` inside a role's block is
picked up on the next run. A reply can run over several lines
(paragraphs, bullet lists): it continues until the next `### HH:MM` entry,
the next reply, or the end of the block.

On the web view, each role block is laid out as a card; the file is
unchanged. The header shows the role's name, its latest declared status,
and when it last reported. The latest report stays open with the replies
and dispatch notes that led to it; earlier entries fold under one
"Earlier" toggle that counts their still-open checkboxes. Your replies show
as "You" bubbles, and dispatch notes as single quiet lines. Above the
cards, **Needs you** lists every still-open checkbox from every role,
labeled with the role's name; ticking one there ticks it in the file,
the same as ticking it in its card.

On the web view of today's plan, each role block ends with a collapsed
**Reply to <Role>** form. What you type there is saved as the block's last
item with `-> <role>:` put in front of it, formatting kept as typed (a
reply that starts with a list or heading starts on the line after the
arrow). The form appears only on today's plan, because that's the file
the next run reads, and only while the roles plugin is enabled. Replies
wait for the next scheduled run; sending one doesn't start a run. The arrow is typed as plain `->`
(hyphen + greater-than); roles treat the typographic `→` as identical, so
either form works. `→ Jeff:` (the user's name) marks items only the user
can resolve — roles write that one, so they use the pretty arrow. An
actionable user escalation is a checkbox-first line, `- [ ] → Jeff: approve
the transfer`; informational items that need no action may use `→ Jeff:`
prose.

## Snapshots and checkboxes

Several runs a day would otherwise pile up stale "to do" prose, with the
real outcome buried at the bottom. Two rules keep the block readable for
humans and AI context alike:

**Checkboxes are stateful; prose is historical.** A role's current state
is its first full report of the day, updated by each later entry that day (a
later entry wins where they conflict), plus every still-open `- [ ]`
checkbox anywhere in its block. Before the first report of a day, the
previous day's state carries over the same way. New entries contain outcomes
and narrative, then only new `- [ ]` items — never restate open checkboxes
from earlier entries. Those boxes stay where they were written until flipped
with `--check` / `--cancel` or ticked by the user. Thus exactly one open
occurrence remains.

**Open items are checkboxes, not prose.** A role writes action items as
`- [ ]` lines. The markdown-tasks plugin picks them up like any other
vault checkbox, and the web UI's checkbox toggling means the user can
check one off from the rendered plan page without editing text. Put the
checkbox first for actionable user escalations:

```bash
plugins/roles/report.js cpa "- [ ] → Jeff: approve the money-market transfer"
plugins/roles/report.js cpa --check "money market"    # - [ ] money market…  → - [x]
plugins/roles/report.js cpa --cancel "Meadow Ridge"   # - [ ] Meadow Ridge…  → - [-] (cancelled)
```

Both flags are repeatable and can combine with a report argument, but
operations apply sequentially, not transactionally: a later failure does
not undo an earlier successful flip. Prefer one flip-only invocation at a
time, then write the report separately. To settle an item in an earlier
day's file, pass that file's date with `--date`; report separately to
today's file. The flip is a single state-character substitution, only
inside the role's own block, and the match must identify exactly one open
checkbox — zero matches, an already-settled match, or an ambiguous match is
an error that leaves the file untouched.

**Amending an entry.** A headline that was right at 04:00 ("greeting to
send today") keeps being read after the user has declined it, by the web
card, the AI context, and the role's own next run. So a role may rewrite
one of its own entries in place:

```bash
plugins/roles/report.js secretary --date 2026-10-15 --amend 16:10 "**Nothing to send: the user declined the greeting.**"
```

The entry is found by its `### HH:MM` heading inside the role's own block
(missing or ambiguous is an error). Its text is replaced; the user's reply
paragraphs inside it are kept verbatim after the new text; a checkbox the
user ticked or that was cancelled keeps its state when the new text repeats
the item; the status line is kept unless `--status` is given; and the entry
gains a `*Amended <date> <time>.*` line so the record shows it changed.
Those are the only permitted mutations of existing block content. User
replies are never rewritten, and freehand edits of earlier entries
(strikethroughs included) remain forbidden.

## Writing reports: plugins/roles/report.js

Roles never edit plan files by hand. The guarded writer, run from the
project root:

```bash
plugins/roles/report.js cpa "Categorized 12 transactions." --status ok
echo "Longer report..." | plugins/roles/report.js cpa --status needs-attention
```

It refuses to run unless the roles plugin is enabled.

It validates the role name (`[a-z0-9-]`, max 32 chars), caps reports at
2,000 characters, rejects text containing `ROLE:`/`TODAY:` markers (which
would corrupt the file's block structure), creates the role's block when
missing (and a minimal plan file, if the plans plugin never templated that
day), and writes atomically with compare-and-swap retries. Statuses: `ok`, `blocked`, `needs-attention`, `quiet`.
`--check "<text>"` / `--cancel "<text>"` flip one open checkbox in the
role's own block, and `--amend <HH:MM>` rewrites one of the role's own
entries in place (see **Snapshots and checkboxes**).

## Reading the past: plugins/roles/history.js

```bash
plugins/roles/history.js secretary            # secretary + chief-of-staff blocks, last 14 days
plugins/roles/history.js cpa --days 7 --no-chief
```

Prints the blocks straight from the plan files (not the database), oldest
first, each verbatim with the user's reply lines in place, under a header
that states the precedence rule. The chief role comes from the plugin's
`chief_role` setting. This is the first command every role runs.

## Running the staff

Enable the plugin and set its run times (wall-clock `HH:MM` in your configured
time zone):

```toml
[plugins.roles.default]
enabled = true
run_times = ["04:00", "08:00", "12:00", "16:00"]
```

Then install the starting role files with `bin/plugins vault-files --install`.

Like `now-updates`, the plugin does its work on the regular plugin sync. Each
sync checks whether a run time has passed since the last run. If so, it starts
the chief of staff (`bin/today --non-interactive --no-sync`, following
`roles/chief-of-staff/SKILL.md`) as a detached background process and returns,
so the run takes as long as it needs; its output goes to
`.data/roles/roles_default.log` (one log per plugin source). If a run is still
going when the next run time
arrives, that run time is skipped. When the plugin is first enabled, it waits
for the next run time rather than starting a run at once. Settings:
`run_times`, `roles_directory` (default `roles`), and `chief_role` (default
`chief-of-staff`).

Only the chief of staff is started by the plugin; every other role runs as a
subagent of its session.

Guardrails (borrowed from a system running in production since 2026-09):

- at most one launch per role per run; one retry, then report the failure;
- roles never launch other roles, and nothing triggers on plan-file edits —
  only the scheduled run reads them, which is the anti-loop defense;
- dispatch decisions are recorded before launching, as a one-line collapsed
  callout, so a crashed run leaves no unaccountable subagents and every run
  leaves a trace even when nothing was due;
- a role with nothing new writes nothing; the chief notes "no change" for
  it, so silence is distinguishable from failure;
- role reports are leads, not facts — the orchestrator verifies anything
  surprising at its source before relaying it to the user.

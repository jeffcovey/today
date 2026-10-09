# Role Agents

Role agents are standing AI helpers — a bookkeeper, a fitness coach, an
innkeeper — defined by the user in their vault and reporting into the daily
diary. They are the optional `roles` plugin (`plugins/roles/`); nothing here
runs or installs unless it is enabled. The diary is the whole interaction model: roles write durable report
blocks, the user replies inline from any device, and the next run reads the
replies. Because diary entries already feed AI context, every `bin/today`
session sees the reports for free, and past diary files are each role's
permanent memory.

See [jeffcovey/today#573](https://github.com/jeffcovey/today/issues/573) for
the original design discussion.

## Role definitions

A role is a directory in the vault with an
[agentskills.io](https://agentskills.io/)-style `SKILL.md`:

```text
vault/roles/
  REPORTING.md              # how every role writes to the diary
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
- **Headline, checkboxes, then a toggle.** One bold headline sentence, then
  any new `- [ ]` items, then everything else inside a collapsed callout
  (`> [!info]- Details`, followed by an empty `>` line, which the web view
  needs to render a toggle). Checkboxes stay outside the callout because the
  task list only sees a checkbox at the start of a line.
- **One checkbox per item.** The chief's summary lists the user's top items
  as numbered prose naming the owning role; the checkbox itself lives once,
  in that role's block.

## Diary ROLE blocks

Reports live in the day's diary file inside marker blocks:

```markdown
<!-- ROLE:cpa:START -->
## 🤖 CPA

### 14:05

**Status:** OK

Categorized 12 transactions.

→ Jeff: approve the money-market transfer?
<!-- ROLE:cpa:END -->
```

The block format lives in `src/diary-role-blocks.js`, shared by the
`markdown-diary` plugin (which parses blocks) and the roles plugin (which
writes them). Properties:

- **Durable.** The `TODAY:` marker namespace is stripped from past days'
  files; `ROLE:` blocks never are. They also count as real content, so a
  day holding only role reports is not cleaned up as empty.
- **Parsed.** Each `### HH:MM` entry inside a block becomes a diary table
  row with `metadata.type: "role"` and `metadata.role: "<name>"` — visible
  to `bin/diary today`, `bin/diary search`, and AI context.
- **Append-only.** New entries are inserted before the END marker; existing
  lines are never rewritten, so replies the user writes inside a block
  survive every later report. The one exception is a checkbox state flip
  (below) — a single-character substitution that never touches prose.

Replies use routing lines: `-> cpa: yes, do it` inside (or near) a role's
block is picked up on the next run. The arrow is typed as plain `->`
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
check one off from the rendered diary page without editing text. Put the
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
today's file. The flip is the **only**
permitted mutation of existing block content: a single state-character
substitution, only inside the role's own block, and the match must
identify exactly one open checkbox — zero matches, an already-settled
match, or an ambiguous match is an error that leaves the file untouched.
Prose, including user replies, stays append-only; freehand edits of
earlier entries (strikethroughs included) remain forbidden.

## Writing reports: plugins/roles/report.js

Roles never edit diary files by hand. The guarded writer, run from the
project root:

```bash
plugins/roles/report.js cpa "Categorized 12 transactions." --status ok
echo "Longer report..." | plugins/roles/report.js cpa --status needs-attention
```

It refuses to run unless the roles plugin is enabled.

It validates the role name (`[a-z0-9-]`, max 32 chars), caps reports at
2,000 characters, rejects text containing `ROLE:`/`TODAY:` markers (which
would corrupt the file's block structure), creates today's diary file and
the role's block when missing, and writes atomically with compare-and-swap
retries. Statuses: `ok`, `blocked`, `needs-attention`, `quiet`.
`--check "<text>"` / `--cancel "<text>"` flip one open checkbox in the
role's own block (see **Snapshots and checkboxes**).

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
`.data/roles/last-run.log`. If a run is still going when the next run time
arrives, that run time is skipped. When the plugin is first enabled, it waits
for the next run time rather than starting a run at once. Settings:
`run_times`, `roles_directory` (default `roles`), and `chief_role` (default
`chief-of-staff`).

Only the chief of staff is started by the plugin; every other role runs as a
subagent of its session.

Guardrails (borrowed from a system running in production since 2026-09):

- at most one launch per role per run; one retry, then report the failure;
- roles never launch other roles, and nothing triggers on diary edits —
  only the scheduled run reads them, which is the anti-loop defense;
- dispatch decisions are recorded before launching, as a one-line collapsed
  callout, so a crashed run leaves no unaccountable subagents and every run
  leaves a trace even when nothing was due;
- a role with nothing new writes nothing; the chief notes "no change" for
  it, so silence is distinguishable from failure;
- role reports are leads, not facts — the orchestrator verifies anything
  surprising at its source before relaying it to the user.

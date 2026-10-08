# Role Agents

Role agents are standing AI helpers — a bookkeeper, a fitness coach, an
innkeeper — defined by the user in their vault and reporting into the daily
diary. The diary is the whole interaction model: roles write durable report
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
  _template/SKILL.md        # copy to create a new role
  chief-of-staff/SKILL.md   # the orchestrator (the only scheduled role)
  <your-role>/SKILL.md
```

Templates ship in `skeleton/roles/` and are installed by
`bin/plugins vault-files --install` **only when missing** — unlike skeleton
scripts, role files belong to the user after install and are never
overwritten, even with `--force`.

Every role file answers the same five sections, so roles stay comparable:

| Section | Answers |
| --- | --- |
| Owns | which sources it reads, which outcomes it watches |
| May do alone | writes it can make without asking |
| Hands to the user | what it must never decide itself |
| Run | the numbered steps of one run, ending in one report |
| Red flags | role-specific hazards |

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

Properties, all enforced by the `markdown-diary` plugin and
`src/diary-roles.js`:

- **Durable.** The `TODAY:` marker namespace is stripped from past days'
  files; `ROLE:` blocks never are. They also count as real content, so a
  day holding only role reports is not cleaned up as empty.
- **Parsed.** Each `### HH:MM` entry inside a block becomes a diary table
  row with `metadata.type: "role"` and `metadata.role: "<name>"` — visible
  to `bin/diary today`, `bin/diary search`, and AI context.
- **Append-only.** New entries are inserted before the END marker; existing
  lines are never rewritten, so replies the user writes inside a block
  survive every later report.

Replies use routing lines: `→ cpa: yes, do it` inside (or near) a role's
block is picked up on the next run. `→ Jeff:` (the user's name) marks items
only the user can resolve.

## bin/role-report

Roles never edit diary files by hand. The guarded writer:

```bash
bin/role-report cpa "Categorized 12 transactions." --status ok
echo "Longer report..." | bin/role-report cpa --status needs-attention
```

It validates the role name (`[a-z0-9-]`, max 32 chars), caps reports at
2,000 characters, rejects text containing `ROLE:`/`TODAY:` markers (which
would corrupt the file's block structure), creates today's diary file and
the role's block when missing, and writes atomically with compare-and-swap
retries. Statuses: `ok`, `blocked`, `needs-attention`, `quiet`.

## Orchestration

Only one role is scheduled: the chief of staff. Everything else runs as a
subagent of its session. Add a scheduler job via your deploy config
(`bin/deploy` writes `.data/scheduler-config.json`):

```json
{
  "name": "chief-of-staff",
  "schedule": "0 8,13,17 * * *",
  "command": "bin/today --non-interactive --quiet 'Read vault/roles/chief-of-staff/SKILL.md and follow it.'"
}
```

Guardrails (borrowed from a system running in production since 2026-09):

- at most one launch per role per run; one retry, then report the failure;
- roles never launch other roles, and nothing triggers on diary edits —
  only the scheduled run reads them, which is the anti-loop defense;
- dispatch decisions are recorded before launching, so a crashed run
  leaves no unaccountable subagents;
- a run with nothing to do still reports a `--status quiet` one-liner, so
  silence is distinguishable from failure;
- role reports are leads, not facts — the orchestrator verifies anything
  surprising at its source before relaying it to the user.

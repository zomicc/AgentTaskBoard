# AgentTaskBoard

**AgentTaskBoard is a local task board and arbitration CLI for coding agents. The board is materialized by a single writer; it is not pushed in real time and it does not synchronize across machines.**

One task has one owner. `atb claim` decides that owner with a machine-readable exit code, while `atb list --since` gives each agent a stable delta cursor for its next turn.

## Status

This repository contains the `v0.1.0` Node.js skeleton. It implements `init`, `doctor`, `rules`, `auto`, `add`, `claim`, `done`, and `list`. It has no web UI, Obsidian dependency, daemon, network service, or cross-machine sync.

## Requirements

- Node.js 20 or newer
- Git is recommended so the project can track its source and the local `.atb/` state stays out of version control

## Install

```sh
npm install -g .
atb --version
```

After `atb init` creates a board in a project, `atb doctor` verifies the local runtime, workspace, board, protocol, and lock state before task commands are used.

## Connect your agents

`atb init` does not edit agent rule files. Run `atb rules install --dry-run` to print every target file and line change, then run `atb rules install` and confirm each file individually. In a pipe or other non-TTY session, installation prints the plan and exits `7` without waiting; use `--yes` only after reviewing that plan.

The automatic installer backs up each file as `<name>.bak-<timestamp>`, replaces only the block between `atb:begin` and `atb:end`, and records installed targets in the user data directory. Use `atb rules status` to inspect them and `atb rules uninstall --yes` to remove a block. `atb doctor --rules` checks that a board exists; without `--expect` it prints a challenge and exits `7`. Ask a fresh agent for the rule probe nonce, then run `atb doctor --rules --expect <agent-answer>`; a matching nonce exits `0`.

## Auto mode

Auto mode is opt-in and workspace-local. `atb init --auto` or `atb auto on` enables it; `atb auto off` disables it, and `atb auto status` reports `enabled`, `window_minutes`, `create_allowed`, and `next_check_after`.
When enabled, `atb claim <slug> --actor <name> --goal "..."` creates an agent-origin task if the slug is absent. With auto off a missing slug exits `4`; with auto on but no goal it exits `5`; an existing task is claimed normally and the supplied goal is ignored. `--no-create` keeps sync on but disables claim-time creation.
`--window` is a check hint, not a timer: it only changes `next_check_after`, used on the next `atb` call or agent-turn boundary. `atb auto on --window 5m`.

Manual installation uses the same self-gated block. Add it to the agent rule files you choose and replace `<nonce>` with a random unique value:

```markdown
<!-- atb:begin protocol:2 -->
AgentTaskBoard may track tasks in this project.
- If `.atb/board.json` does not exist in the current working directory, ignore this block entirely.
- If it exists: run `atb list --since <cursor>` when starting, or when now is later than `next_check_after`.
  Use `atb claim <slug> --actor <name>` to take one, and
  `atb done <slug> --actor <name> --evidence-kind commit|path|test --evidence-ref <ref>` to finish.
- If that claim exits 4 while auto mode is enabled, retry with `--goal`; the retry may create an agent task.
  Deliverable is optional for this claim-time registration, but never treat exit 4 as success.
- Exit codes are authoritative: 3 = owned by someone else, 4 = no such task, 7 = unconfirmed, 10 = workspace unusable.
  Never treat a non-zero exit as success.
- Never edit `.atb/` or any rule file by hand.
- Rule probe nonce: <nonce>
<!-- atb:end -->
```

Manual targets are `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.zcode/AGENTS.md`, `~/.agents/AGENTS.md`, and `$DSH_HOME/AGENTS.md`. Claude Code can load a project `AGENTS.md` through a one-line `CLAUDE.md` containing `@AGENTS.md`.

For development, run the CLI directly:

```sh
node bin/atb.js --help
```

## Quick Start

```sh
mkdir demo
cd demo
atb init
atb doctor
atb add --slug first-task --project demo --goal "Add the first task" --deliverable "README.md" --stage design
atb claim first-task --actor builder
atb list --since 0
atb done first-task --actor builder --evidence-kind path --evidence-ref "."
```

Every command accepts `--workspace <path>` and defaults to the current directory. The workspace root is stored as `workspace_ref`; `working_subdir` stays relative so the task definition remains readable.

## Task Model

| Field | Meaning |
| --- | --- |
| `id` | Stable UUID for the task |
| `slug` | Human-friendly unique reference |
| `project` | Project label |
| `goal` | Required statement of the intended result |
| `workspace_ref` | Absolute project root used for this local board |
| `working_subdir` | Optional task directory relative to `workspace_ref` |
| `deliverables` | Required paths or commands that identify the output |
| `stage` | Free-form workflow stage such as `design`, `impl`, or `verify` |
| `status` | `todo`, `claimed`, or `done` |
| `owner` | The actor that successfully claimed the task |
| `outcome` | Result recorded by `atb done` |
| `origin` | `user` for `atb add`, or `agent` for claim-time registration |
| `spec_revision` | Task-definition revision, starting at `1` |

## Commands

| Command | Behavior |
| --- | --- |
| `atb init` | Creates `.atb/board.json` under the workspace root. Safe to run again. |
| `atb doctor` | Checks Node.js, workspace writability, board protocol, and residual locks. |
| `atb rules install` | Previews, confirms, backs up, and installs self-gated agent rules. |
| `atb rules status` | Reports installed rules, protocol, block hash, and nonce. |
| `atb rules uninstall` | Removes only the managed rule block and keeps backups. |
| `atb doctor --rules` | Verifies a board and a nonce returned by a fresh agent. |
| `atb auto` | Shows or changes workspace-local automatic claim and sync hints. |
| `atb add` | Adds a task with a goal, workspace reference, deliverables, and stage. |
| `atb claim` | Claims a task; auto mode can create it when `--goal` is supplied. |
| `atb done` | Completes a claimed task for its owner and records evidence. |
| `atb list` | Shows tasks and events after `--since`, optionally filtered by `--origin`. |

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `3` | Claim conflict: the task already has another owner or is complete |
| `4` | Task not found, or auto status requested before `init` |
| `5` | Invalid command or arguments |
| `6` | Board is missing, locked, or unavailable |
| `7` | Completion rejected because the actor is not the owner |
| `8` | Board state is corrupt or has an unsupported protocol |
| `9` | Duplicate task slug |
| `10` | Workspace or working directory is missing or not writable |

Internal design notes are kept out of the public repository.

## Local State

Runtime state lives in `<workspace>/.atb/`. The repository's `.gitignore` excludes it. Commands serialize writes with `.atb/lock`; readers use the latest persisted board snapshot. The consistency model is linearized writes on one machine and eventually observed reads at the next command or agent turn.

## License

MIT. See [LICENSE](LICENSE).

# AgentTaskBoard

**AgentTaskBoard is a local task board and arbitration CLI for coding agents. The board is materialized by a single writer; it is not pushed in real time and it does not synchronize across machines.**

One task has one owner. `atb claim` decides that owner with a machine-readable exit code, while `atb list --since` gives each agent a stable delta cursor for its next turn.

## Status

This repository contains the `v0.1.0` Node.js skeleton. It implements the five commands `init`, `add`, `claim`, `done`, and `list`. It has no web UI, Obsidian dependency, daemon, network service, or cross-machine sync.

## Requirements

- Node.js 20 or newer
- Git is recommended so the project can track its source and the local `.atb/` state stays out of version control

## Install

```sh
npm install -g .
atb --version
```

After `atb init` creates a board in a project, `atb doctor` verifies the local runtime, workspace, board, protocol, and lock state before task commands are used.

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
| `spec_revision` | Task-definition revision, starting at `1` |

## Commands

| Command | Behavior |
| --- | --- |
| `atb init` | Creates `.atb/board.json` under the workspace root. Safe to run again. |
| `atb doctor` | Checks Node.js, workspace writability, board protocol, and residual locks. |
| `atb add` | Adds a task with a goal, workspace reference, deliverables, and stage. |
| `atb claim` | Claims a task for one actor. A second actor exits with code `3`. |
| `atb done` | Completes a claimed task for its owner and records evidence. |
| `atb list` | Shows current tasks and events after an optional `--since` cursor. |

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `3` | Claim conflict: the task already has another owner or is complete |
| `4` | Task not found |
| `5` | Invalid command or arguments |
| `6` | Board is missing, locked, or unavailable |
| `7` | Completion rejected because the actor is not the owner |
| `8` | Board state is corrupt or has an unsupported protocol |
| `9` | Duplicate task slug |
| `10` | Workspace or working directory is missing or not writable |

Detailed field rules are in [docs/DESIGN.md](docs/DESIGN.md) and the machine protocol is in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Local State

Runtime state lives in `<workspace>/.atb/`. The repository's `.gitignore` excludes it. Commands serialize writes with `.atb/lock`; readers use the latest persisted board snapshot. The consistency model is linearized writes on one machine and eventually observed reads at the next command or agent turn.

## License

MIT. See [LICENSE](LICENSE).

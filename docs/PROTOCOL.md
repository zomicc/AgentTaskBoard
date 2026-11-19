# AgentTaskBoard Protocol

Protocol identifier: `agenttaskboard-protocol: 1`

The v0.1 implementation persists one JSON board at `<workspace>/.atb/board.json`. The board is local and single-machine; no network transport is defined.

## Board Envelope

```json
{
  "protocol": "agenttaskboard-protocol: 1",
  "version": 1,
  "next_seq": 1,
  "tasks": [],
  "events": []
}
```

`next_seq` is the next event sequence number. Every successful mutation appends one event and increments it by one.

## Task Object

```json
{
  "id": "c6f9d5d7-2f1a-4aa7-a3ad-59c34e30a39d",
  "slug": "example-task",
  "project": "example",
  "goal": "Describe the intended result",
  "workspace_ref": "C:\\work\\example",
  "working_subdir": "src",
  "deliverables": ["src/feature.js"],
  "stage": "design",
  "status": "todo",
  "owner": null,
  "outcome": null,
  "evidence_kind": null,
  "evidence_ref": null,
  "spec_revision": 1,
  "created_ts": "2026-01-01T00:00:00.000Z",
  "updated_ts": "2026-01-01T00:00:00.000Z"
}
```

`workspace_ref` is the canonical local project root. `working_subdir` is relative to it. A claim event carries the resolved `run_cwd`; that runtime path does not replace the task definition.

## Events

Each event has:

```json
{
  "seq": 1,
  "task_id": "c6f9d5d7-2f1a-4aa7-a3ad-59c34e30a39d",
  "kind": "added",
  "payload": {},
  "ts": "2026-01-01T00:00:00.000Z"
}
```

Event kinds are `added`, `claimed`, and `done`.

## Commands

### init

Creates `.atb/board.json` if it is absent. Running `init` again validates and preserves the existing board.

### doctor

```text
atb doctor [--workspace <path>]
```

Performs a read-only installation check and returns JSON. It verifies the Node.js version, workspace writability, board presence and writability, protocol validity, and residual lock state.

| Code | Meaning |
| --- | --- |
| `0` | All checks passed |
| `6` | Board is absent, unavailable, or locked |
| `8` | Board JSON or protocol is invalid |
| `10` | Workspace is absent or unusable |

### add

Required options: `--slug`, `--goal`, and at least one `--deliverable`.

Optional options: `--project`, `--workspace`, `--working-subdir`, and `--stage`.

The command exits `9` when the slug already exists.

### claim

```text
atb claim <task-id-or-slug> --actor <name>
```

A `todo` task becomes `claimed` by the requested actor. A repeated claim by that owner is idempotent. Any other actor exits `3`.

### done

```text
atb done <task-id-or-slug> --actor <name> --evidence-kind <kind> --evidence-ref <ref>
```

Only the current owner can complete the task. Supported evidence kinds are `commit`, `path`, and `test`. The result defaults to `done` and can be changed with `--outcome`.

### list

```text
atb list [--since <seq>] [--workspace <path>]
```

The JSON result contains:

- `items`: events after the cursor, each with its current task snapshot
- `tasks`: every current task snapshot
- `next_cursor`: the sequence to store after processing the page
- `has_more`: always `false` in v0.1 because the full local page is returned

The cursor is at-least-once. A consumer must persist it only after processing the returned items.

## Exit Contract

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `3` | Claim conflict |
| `4` | Task not found |
| `5` | Invalid command or arguments |
| `6` | Board unavailable or locked |
| `7` | Completion by a non-owner |
| `8` | Corrupt state or unsupported protocol |
| `9` | Duplicate slug |
| `10` | Workspace or working directory unavailable |

# AgentTaskBoard Design

## Positioning

AgentTaskBoard is a local task board and arbitration tool for coding agents. Its job is to answer one question deterministically: which actor owns a task now?

It is deliberately not a real-time board, a hosted service, or a cross-machine synchronization product. Cross-machine synchronization is outside v1 and would require a separate product identity.

## Consistency Model

- Writes are linearized on one machine. Each mutating command acquires `.atb/lock`, reads the board, changes it, writes the new snapshot, and releases the lock.
- Reads are eventually observed at the next `atb list` call or the next agent turn boundary. AgentTaskBoard does not promise background refresh or a fixed refresh interval.
- Tasks are materialized as current snapshots; every mutation also appends an immutable event with a monotonically increasing `seq`.
- `atb list --since <seq>` returns events after that cursor. Consumers should advance their cursor only after processing the page.

## Task Definition

| Field | Type | Required | Writer | Rule |
| --- | --- | --- | --- | --- |
| `id` | UUID string | Yes | `add` | Stable task identity |
| `slug` | string | Yes | `add` | Unique within the board |
| `project` | string | Yes | `add` | Defaults to `default` |
| `goal` | string | Yes | `add` | Describes the intended result |
| `workspace_ref` | absolute path | Yes | `add` | Resolved project root |
| `working_subdir` | relative path | No | `add` | Must resolve inside `workspace_ref` |
| `deliverables` | string array | Yes | `add` | At least one output path or command |
| `stage` | string | Yes | `add` | Defaults to `design` |
| `status` | enum | Yes | `add`, `claim`, `done` | `todo`, `claimed`, or `done` |
| `owner` | string or null | Yes | `claim` | Set only by a successful claim |
| `outcome` | string or null | Yes | `done` | Result recorded on completion |
| `evidence_kind` | enum or null | Yes | `done` | `commit`, `path`, or `test` |
| `evidence_ref` | string or null | Yes | `done` | Evidence submitted by the owner |
| `spec_revision` | integer | Yes | `add` | Starts at `1` |

The CLI resolves `workspace_ref` with `realpath` and checks that `working_subdir` stays inside it. A claim resolves the run directory again, checks that it is a writable directory, and records the resolved `run_cwd` in the claim event. The run directory is deliberately not stored as the task's canonical identity.

## Workflow

1. `init` creates the local board idempotently.
2. `add` creates a task in `todo`.
3. `claim` atomically changes `todo` to `claimed` and sets one owner.
4. `done` completes a claimed task only when the caller is its owner.
5. `list --since` exposes current snapshots and the next delta page.

## Conflict Rules

- A second actor claiming a claimed or completed task exits `3`.
- Repeating a claim by the same owner is idempotent and succeeds.
- Completion by a different actor exits `7`.
- Duplicate slugs exit `9`; they are not merged semantically.
- A stale lock older than 30 seconds may be removed by the next writer.

## Exit Codes

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | `OK` | Success |
| `3` | `CONFLICT` | Claim conflict |
| `4` | `NOT_FOUND` | Task not found |
| `5` | `INVALID` | Invalid command or arguments |
| `6` | `BOARD_UNAVAILABLE` | Missing board or lock timeout |
| `7` | `NOT_OWNER` | Completion rejected for a non-owner |
| `8` | `CORRUPT_STATE` | Corrupt JSON, schema, or protocol |
| `9` | `DUPLICATE` | Duplicate slug |
| `10` | `UNWRITABLE` | Workspace or working directory cannot be used |

## v0.1 Boundaries

This version has no daemon, web UI, Obsidian dependency, vault writes, automatic owner takeover, semantic deduplication, command execution for test evidence, or network synchronization. A future view layer may read the JSON protocol without changing the claim path.

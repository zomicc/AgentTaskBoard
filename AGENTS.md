# AgentTaskBoard Project Instructions

This repository develops AgentTaskBoard itself. Its runtime board is `.atb/board.json`; that directory is local and git-ignored.

1. Start each turn with `atb list --since <cursor>`, using the cursor saved from your previous turn.
2. Claim work before changing files: `atb claim <task-id-or-slug> --actor <name>`.
3. After verification, finish it with `atb done ... --evidence-kind <commit|path|test> --evidence-ref <evidence>`.
4. Run `atb doctor` when setup, board state, or locking looks wrong.
5. Do not commit `.atb/`.

Use the CLI as the task coordination source; do not edit board state by hand.

#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL = 'agenttaskboard-protocol: 1';
const VERSION = '0.1.0';
const STATE_DIR = '.atb';
const BOARD_FILE = 'board.json';

const EXIT = Object.freeze({
  OK: 0,
  CONFLICT: 3,
  NOT_FOUND: 4,
  INVALID: 5,
  BOARD_UNAVAILABLE: 6,
  NOT_OWNER: 7,
  CORRUPT_STATE: 8,
  DUPLICATE: 9,
  UNWRITABLE: 10,
});

const OPTIONS = new Set([
  'workspace',
  'slug',
  'project',
  'goal',
  'working-subdir',
  'deliverable',
  'stage',
  'actor',
  'outcome',
  'evidence-kind',
  'evidence-ref',
  'since',
]);

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function usage() {
  return [
    'Usage:',
    '  atb init [--workspace <path>]',
    '  atb doctor [--workspace <path>]',
    '  atb add --slug <slug> --goal <text> --deliverable <path> [options]',
    '  atb claim <task-id-or-slug> --actor <name> [--workspace <path>]',
    '  atb done <task-id-or-slug> --actor <name> --evidence-kind <kind> --evidence-ref <ref>',
    '  atb list [--since <seq>] [--workspace <path>]',
    '  atb --version',
    '',
    'Common options:',
    '  --workspace <path>       Project root containing .atb/ (default: current directory)',
    '  --project <name>         Project label (default: default)',
    '  --working-subdir <path>  Task directory relative to the workspace',
    '  --stage <name>           Task stage (default: design)',
  ].join('\n');
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { command: 'help', options: {}, positionals: [] };
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    return { command: 'version', options: {}, positionals: [] };
  }

  const command = argv[0];
  const options = { deliverable: [] };
  const positionals = [];

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf('=');
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (!OPTIONS.has(name)) {
      throw new CliError(EXIT.INVALID, `unknown option --${name}`);
    }

    let value;
    if (equals !== -1) {
      value = token.slice(equals + 1);
    } else {
      index += 1;
      value = argv[index];
      if (value === undefined || value.startsWith('--')) {
        throw new CliError(EXIT.INVALID, `option --${name} requires a value`);
      }
    }

    if (name === 'deliverable') {
      options.deliverable.push(value);
    } else if (options[name] !== undefined) {
      throw new CliError(EXIT.INVALID, `option --${name} may only be given once`);
    } else {
      options[name] = value;
    }
  }

  return { command, options, positionals };
}

function requireValue(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError(EXIT.INVALID, `--${name} is required`);
  }
  return value.trim();
}

function resolveWorkspace(value) {
  const requested = path.resolve(value || process.cwd());
  let root;
  try {
    root = fs.realpathSync(requested);
  } catch {
    throw new CliError(EXIT.UNWRITABLE, `workspace does not exist: ${requested}`);
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new CliError(EXIT.UNWRITABLE, `workspace is not a directory: ${root}`);
  }
  return root;
}

function statePaths(workspace) {
  const stateDir = path.join(workspace, STATE_DIR);
  return {
    stateDir,
    boardPath: path.join(stateDir, BOARD_FILE),
    lockPath: path.join(stateDir, 'lock'),
  };
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireLock(stateDir) {
  const lockPath = path.join(stateDir, 'lock');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(
        descriptor,
        JSON.stringify({ pid: process.pid, created_ts: new Date().toISOString() }),
        'utf8',
      );
      fs.closeSync(descriptor);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new CliError(EXIT.BOARD_UNAVAILABLE, `cannot lock board: ${error.message}`);
      }
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > 30_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') {
          continue;
        }
      }
      pause(25);
    }
  }
  throw new CliError(EXIT.BOARD_UNAVAILABLE, 'board is locked by another AgentTaskBoard process');
}

function emptyBoard() {
  return {
    protocol: PROTOCOL,
    version: 1,
    next_seq: 1,
    tasks: [],
    events: [],
  };
}

function validateBoard(board, boardPath) {
  if (
    !board ||
    board.protocol !== PROTOCOL ||
    board.version !== 1 ||
    !Number.isInteger(board.next_seq) ||
    !Array.isArray(board.tasks) ||
    !Array.isArray(board.events)
  ) {
    throw new CliError(EXIT.CORRUPT_STATE, `unsupported or corrupt board: ${boardPath}`);
  }
  return board;
}

function readBoard(boardPath) {
  try {
    return validateBoard(JSON.parse(fs.readFileSync(boardPath, 'utf8')), boardPath);
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(EXIT.CORRUPT_STATE, `cannot read board: ${error.message}`);
  }
}

function writeBoard(boardPath, board) {
  try {
    fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new CliError(EXIT.UNWRITABLE, `cannot write board: ${error.message}`);
  }
}

function withBoard(workspace, callback) {
  const paths = statePaths(workspace);
  if (!fs.existsSync(paths.boardPath)) {
    throw new CliError(
      EXIT.BOARD_UNAVAILABLE,
      `board is not initialized in ${workspace}; run "atb init"`,
    );
  }
  const release = acquireLock(paths.stateDir);
  try {
    return callback(readBoard(paths.boardPath), paths.boardPath);
  } finally {
    release();
  }
}

function appendEvent(board, task, kind, payload) {
  const event = {
    seq: board.next_seq,
    task_id: task.id,
    kind,
    payload,
    ts: new Date().toISOString(),
  };
  board.next_seq += 1;
  board.events.push(event);
  return event.seq;
}

function findTask(board, reference) {
  const task = board.tasks.find((item) => item.id === reference || item.slug === reference);
  if (!task) {
    throw new CliError(EXIT.NOT_FOUND, `task not found: ${reference}`);
  }
  return task;
}

function resolveWorkingDirectory(root, subdirectory) {
  const relative = subdirectory || '';
  if (path.isAbsolute(relative)) {
    throw new CliError(EXIT.INVALID, '--working-subdir must be relative to the workspace');
  }
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  if (relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new CliError(EXIT.UNWRITABLE, 'working directory is outside the workspace');
  }
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error('not a directory');
    }
    fs.accessSync(resolved, fs.constants.W_OK);
  } catch (error) {
    throw new CliError(EXIT.UNWRITABLE, `working directory is not writable: ${error.message}`);
  }
  return resolved;
}

function commandInit(options, positionals) {
  if (positionals.length !== 0 || options.deliverable.length !== 0) {
    throw new CliError(EXIT.INVALID, 'init does not take positional arguments');
  }
  const workspace = resolveWorkspace(options.workspace);
  const paths = statePaths(workspace);
  try {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.accessSync(paths.stateDir, fs.constants.W_OK);
  } catch (error) {
    throw new CliError(EXIT.UNWRITABLE, `cannot create state directory: ${error.message}`);
  }

  const release = acquireLock(paths.stateDir);
  try {
    if (fs.existsSync(paths.boardPath)) {
      readBoard(paths.boardPath);
    } else {
      writeBoard(paths.boardPath, emptyBoard());
    }
  } finally {
    release();
  }

  return {
    ok: true,
    workspace_ref: workspace,
    board: paths.boardPath,
    protocol: PROTOCOL,
  };
}

function commandDoctor(options, positionals) {
  if (positionals.length !== 0 || options.deliverable.length !== 0) {
    throw new CliError(EXIT.INVALID, 'doctor does not take positional arguments');
  }

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new CliError(
      EXIT.UNWRITABLE,
      `unsupported Node.js ${process.versions.node}; AgentTaskBoard requires Node.js 20 or newer`,
    );
  }

  const workspace = resolveWorkspace(options.workspace);
  try {
    fs.accessSync(workspace, fs.constants.W_OK);
  } catch (error) {
    throw new CliError(EXIT.UNWRITABLE, `workspace is not writable: ${error.message}`);
  }

  const paths = statePaths(workspace);
  if (!fs.existsSync(paths.stateDir) || !fs.existsSync(paths.boardPath)) {
    throw new CliError(
      EXIT.BOARD_UNAVAILABLE,
      `board is not initialized in ${workspace}; run "atb init"`,
    );
  }
  try {
    if (!fs.statSync(paths.stateDir).isDirectory()) {
      throw new Error('state path is not a directory');
    }
    fs.accessSync(paths.stateDir, fs.constants.W_OK);
    fs.accessSync(paths.boardPath, fs.constants.W_OK);
  } catch (error) {
    throw new CliError(EXIT.BOARD_UNAVAILABLE, `board is not writable: ${error.message}`);
  }

  let lockPresent = false;
  let lockStale = false;
  if (fs.existsSync(paths.lockPath)) {
    lockPresent = true;
    try {
      lockStale = Date.now() - fs.statSync(paths.lockPath).mtimeMs > 30_000;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new CliError(EXIT.BOARD_UNAVAILABLE, `cannot inspect board lock: ${error.message}`);
      }
      lockPresent = false;
    }
  }
  if (lockPresent) {
    throw new CliError(
      EXIT.BOARD_UNAVAILABLE,
      `board has a ${lockStale ? 'stale ' : ''}lock: ${paths.lockPath}`,
    );
  }

  const board = readBoard(paths.boardPath);
  return {
    ok: true,
    version: VERSION,
    node: {
      version: process.versions.node,
      required: '>=20',
      supported: true,
    },
    workspace_ref: workspace,
    workspace_writable: true,
    board: {
      path: paths.boardPath,
      exists: true,
      protocol: board.protocol,
      valid: true,
    },
    lock: {
      present: false,
      stale: false,
    },
    checks: {
      node_version: true,
      workspace_writable: true,
      board_readable: true,
      protocol_valid: true,
      lock_clear: true,
    },
  };
}

function commandAdd(options, positionals) {
  if (positionals.length !== 0) {
    throw new CliError(EXIT.INVALID, 'add takes options, not positional arguments');
  }
  const workspace = resolveWorkspace(options.workspace);
  const workingDirectory = resolveWorkingDirectory(workspace, options['working-subdir']);
  const slug = requireValue(options.slug, 'slug');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
    throw new CliError(EXIT.INVALID, '--slug may contain only letters, numbers, ".", "_" and "-"');
  }
  const goal = requireValue(options.goal, 'goal');
  if (options.deliverable.length === 0) {
    throw new CliError(EXIT.INVALID, 'at least one --deliverable is required');
  }
  const deliverables = options.deliverable.map((item) => requireValue(item, 'deliverable'));
  const stage = options.stage ? requireValue(options.stage, 'stage') : 'design';
  const project = options.project ? requireValue(options.project, 'project') : 'default';
  const now = new Date().toISOString();

  return withBoard(workspace, (board, boardPath) => {
    if (board.tasks.some((task) => task.slug === slug)) {
      throw new CliError(EXIT.DUPLICATE, `task slug already exists: ${slug}`);
    }
    const task = {
      id: crypto.randomUUID(),
      slug,
      project,
      goal,
      workspace_ref: workspace,
      working_subdir: options['working-subdir'] || '',
      deliverables,
      stage,
      status: 'todo',
      owner: null,
      outcome: null,
      evidence_kind: null,
      evidence_ref: null,
      spec_revision: 1,
      created_ts: now,
      updated_ts: now,
    };
    board.tasks.push(task);
    const seq = appendEvent(board, task, 'added', { actor: null });
    writeBoard(boardPath, board);
    return { ok: true, seq, task };
  });
}

function commandClaim(options, positionals) {
  if (positionals.length !== 1) {
    throw new CliError(EXIT.INVALID, 'claim requires one task id or slug');
  }
  const workspace = resolveWorkspace(options.workspace);
  const actor = requireValue(options.actor, 'actor');

  return withBoard(workspace, (board, boardPath) => {
    const task = findTask(board, positionals[0]);
    if (task.status === 'claimed' && task.owner === actor) {
      return { ok: true, claimed: false, task };
    }
    if (task.status !== 'todo') {
      throw new CliError(
        EXIT.CONFLICT,
        `task ${task.slug} is already ${task.status}${task.owner ? ` by ${task.owner}` : ''}`,
      );
    }

    const runCwd = resolveWorkingDirectory(workspace, task.working_subdir);
    const now = new Date().toISOString();
    task.status = 'claimed';
    task.owner = actor;
    task.updated_ts = now;
    const seq = appendEvent(board, task, 'claimed', { actor, run_cwd: runCwd });
    writeBoard(boardPath, board);
    return { ok: true, claimed: true, seq, run_cwd: runCwd, task };
  });
}

function commandDone(options, positionals) {
  if (positionals.length !== 1) {
    throw new CliError(EXIT.INVALID, 'done requires one task id or slug');
  }
  const workspace = resolveWorkspace(options.workspace);
  const actor = requireValue(options.actor, 'actor');
  const evidenceKind = requireValue(options['evidence-kind'], 'evidence-kind');
  const evidenceRef = requireValue(options['evidence-ref'], 'evidence-ref');
  const outcome = options.outcome ? requireValue(options.outcome, 'outcome') : 'done';
  if (!['commit', 'path', 'test'].includes(evidenceKind)) {
    throw new CliError(EXIT.INVALID, '--evidence-kind must be commit, path or test');
  }

  return withBoard(workspace, (board, boardPath) => {
    const task = findTask(board, positionals[0]);
    if (task.status === 'done' && task.owner === actor) {
      return { ok: true, completed: false, task };
    }
    if (task.status !== 'claimed' || task.owner !== actor) {
      throw new CliError(
        EXIT.NOT_OWNER,
        `task ${task.slug} is not claimed by ${actor}`,
      );
    }
    const now = new Date().toISOString();
    task.status = 'done';
    task.outcome = outcome;
    task.evidence_kind = evidenceKind;
    task.evidence_ref = evidenceRef;
    task.updated_ts = now;
    const seq = appendEvent(board, task, 'done', {
      actor,
      outcome,
      evidence_kind: evidenceKind,
      evidence_ref: evidenceRef,
    });
    writeBoard(boardPath, board);
    return { ok: true, completed: true, seq, task };
  });
}

function parseSince(value) {
  if (value === undefined) {
    return 0;
  }
  if (!/^\d+$/.test(value)) {
    throw new CliError(EXIT.INVALID, '--since must be a non-negative integer');
  }
  return Number(value);
}

function commandList(options, positionals) {
  if (positionals.length !== 0) {
    throw new CliError(EXIT.INVALID, 'list takes options, not positional arguments');
  }
  const workspace = resolveWorkspace(options.workspace);
  const since = parseSince(options.since);

  return withBoard(workspace, (board) => {
    const tasksById = new Map(board.tasks.map((task) => [task.id, task]));
    const items = board.events
      .filter((event) => event.seq > since)
      .map((event) => ({
        ...event,
        task: tasksById.get(event.task_id) || null,
      }));
    const nextCursor =
      items.length > 0 ? items[items.length - 1].seq : since;
    return {
      ok: true,
      protocol: PROTOCOL,
      items,
      tasks: board.tasks,
      next_cursor: nextCursor,
      has_more: false,
    };
  });
}

function run(argv) {
  const parsed = parseArgs(argv);
  switch (parsed.command) {
    case 'help':
      process.stdout.write(`${usage()}\n`);
      return EXIT.OK;
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return EXIT.OK;
    case 'init':
      process.stdout.write(`${JSON.stringify(commandInit(parsed.options, parsed.positionals), null, 2)}\n`);
      return EXIT.OK;
    case 'doctor':
      process.stdout.write(`${JSON.stringify(commandDoctor(parsed.options, parsed.positionals), null, 2)}\n`);
      return EXIT.OK;
    case 'add':
      process.stdout.write(`${JSON.stringify(commandAdd(parsed.options, parsed.positionals), null, 2)}\n`);
      return EXIT.OK;
    case 'claim':
      process.stdout.write(`${JSON.stringify(commandClaim(parsed.options, parsed.positionals), null, 2)}\n`);
      return EXIT.OK;
    case 'done':
      process.stdout.write(`${JSON.stringify(commandDone(parsed.options, parsed.positionals), null, 2)}\n`);
      return EXIT.OK;
    case 'list':
      process.stdout.write(`${JSON.stringify(commandList(parsed.options, parsed.positionals), null, 2)}\n`);
      return EXIT.OK;
    default:
      throw new CliError(EXIT.INVALID, `unknown command: ${parsed.command}`);
  }
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  const code = error instanceof CliError ? error.code : EXIT.CORRUPT_STATE;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, code, error: message })}\n`);
  if (error instanceof CliError && error.code === EXIT.INVALID) {
    process.stderr.write(`${usage()}\n`);
  }
  process.exitCode = code;
}

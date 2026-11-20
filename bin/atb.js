#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL = 'agenttaskboard-protocol: 1';
const VERSION = '0.1.0';
const STATE_DIR = '.atb';
const BOARD_FILE = 'board.json';
const CONFIG_FILE = 'config.json';
const DEFAULT_WINDOW_MINUTES = 5;
const RULES_PROTOCOL = 'atb:begin protocol:2';
const RULES_STATE_VERSION = 1;
const RULE_SCOPES = new Set(['global', 'project', 'both']);

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
  'scope',
  'only',
  'expect',
  'window',
  'origin',
]);

const BOOLEAN_OPTIONS = new Set([
  'dry-run',
  'yes',
  'force',
  'rules',
  'auto',
  'no-create',
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
    '  atb init --auto [--window <duration>] [--no-create] [--workspace <path>]',
    '  atb doctor [--workspace <path>]',
    '  atb doctor --rules [--workspace <path>] [--expect <answer>]',
    '  atb rules install [--scope global|project|both] [--dry-run] [--yes]',
    '  atb rules status [--scope global|project|both] [--workspace <path>]',
    '  atb rules uninstall [--scope global|project|both] [--dry-run] [--yes]',
    '  atb auto on|off|status [--window <duration>] [--no-create] [--workspace <path>]',
    '  atb add --slug <slug> --goal <text> --deliverable <path> [options]',
    '  atb claim <task-id-or-slug> --actor <name> [--goal <text>] [--deliverable <path>] [--workspace <path>]',
    '  atb done <task-id-or-slug> --actor <name> --evidence-kind <kind> --evidence-ref <ref>',
    '  atb list [--since <seq>] [--origin user|agent] [--workspace <path>]',
    '  atb --version',
    '',
    'Common options:',
    '  --workspace <path>       Project root containing .atb/ (default: current directory)',
    '  --project <name>         Project label (default: default)',
    '  --working-subdir <path>  Task directory relative to the workspace',
    '  --stage <name>           Task stage (default: design)',
    '  --scope <scope>          Rule targets: global, project, or both',
    '  --only <name>            Limit rules to one or more named targets',
    '  --window <duration>      Auto check interval (default: 5m; not a timer)',
    '  --no-create              In auto mode, never create tasks during claim',
    '  --origin <origin>        Filter list results by user or agent',
    '  --dry-run                Print the change plan without writing',
    '  --yes                    Apply every selected rule change without prompting',
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
  const options = { deliverable: [], only: [] };
  const positionals = [];

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf('=');
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (!OPTIONS.has(name) && !BOOLEAN_OPTIONS.has(name)) {
      throw new CliError(EXIT.INVALID, `unknown option --${name}`);
    }

    if (BOOLEAN_OPTIONS.has(name)) {
      if (equals !== -1) {
        throw new CliError(EXIT.INVALID, `option --${name} does not take a value`);
      }
      if (options[name] !== undefined) {
        throw new CliError(EXIT.INVALID, `option --${name} may only be given once`);
      }
      options[name] = true;
      continue;
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

    if (name === 'deliverable' || name === 'only') {
      options[name].push(value);
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
    configPath: path.join(stateDir, CONFIG_FILE),
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
  for (const task of board.tasks) {
    if (task.origin === undefined) {
      task.origin = 'user';
    } else if (task.origin !== 'user' && task.origin !== 'agent') {
      throw new CliError(EXIT.CORRUPT_STATE, `unsupported task origin: ${task.origin}`);
    }
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

function defaultAutoConfig() {
  return {
    auto: {
      enabled: false,
      window_minutes: DEFAULT_WINDOW_MINUTES,
      create_allowed: true,
      updated_ts: null,
    },
  };
}

function readAutoConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return defaultAutoConfig();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const auto = parsed && parsed.auto;
    if (
      !auto ||
      typeof auto.enabled !== 'boolean' ||
      !Number.isInteger(auto.window_minutes) ||
      auto.window_minutes <= 0 ||
      typeof auto.create_allowed !== 'boolean'
    ) {
      throw new Error('invalid auto configuration');
    }
    return {
      auto: {
        enabled: auto.enabled,
        window_minutes: auto.window_minutes,
        create_allowed: auto.create_allowed,
        updated_ts: typeof auto.updated_ts === 'string' ? auto.updated_ts : null,
      },
    };
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(EXIT.CORRUPT_STATE, `cannot read auto configuration: ${error.message}`);
  }
}

function writeAutoConfig(configPath, config) {
  try {
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new CliError(EXIT.UNWRITABLE, `cannot write auto configuration: ${error.message}`);
  }
}

function parseWindow(value) {
  if (value === undefined) {
    return DEFAULT_WINDOW_MINUTES;
  }
  const match = /^(\d+)(m|h)$/i.exec(String(value).trim());
  if (!match) {
    throw new CliError(EXIT.INVALID, '--window must be a positive duration such as 5m or 1h');
  }
  const amount = Number(match[1]);
  const minutes = match[2].toLowerCase() === 'h' ? amount * 60 : amount;
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1440) {
    throw new CliError(EXIT.INVALID, '--window must be between 1 minute and 24 hours');
  }
  return minutes;
}

function autoNextCheck(config, now = Date.now()) {
  const auto = config.auto;
  if (!auto.enabled) {
    return null;
  }
  return new Date(now + auto.window_minutes * 60_000).toISOString();
}

function autoSnapshot(config) {
  return {
    enabled: config.auto.enabled,
    window_minutes: config.auto.window_minutes,
    create_allowed: config.auto.create_allowed,
    next_check_after: autoNextCheck(config),
  };
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

function homeDirectory() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function userDataDirectory() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(homeDirectory(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') {
    return path.join(homeDirectory(), 'Library', 'Application Support');
  }
  return process.env.XDG_DATA_HOME || path.join(homeDirectory(), '.local', 'share');
}

function rulesStatePath() {
  return path.join(userDataDirectory(), 'atb', 'rules.json');
}

function emptyRulesState() {
  return { version: RULES_STATE_VERSION, targets: {} };
}

function readRulesState() {
  const statePath = rulesStatePath();
  if (!fs.existsSync(statePath)) {
    return emptyRulesState();
  }
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (
      !state ||
      state.version !== RULES_STATE_VERSION ||
      !state.targets ||
      typeof state.targets !== 'object' ||
      Array.isArray(state.targets)
    ) {
      throw new Error('unsupported rules state');
    }
    return state;
  } catch (error) {
    throw new CliError(EXIT.CORRUPT_STATE, `cannot read rules state: ${error.message}`);
  }
}

function writeRulesState(state) {
  const statePath = rulesStatePath();
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new CliError(EXIT.UNWRITABLE, `cannot write rules state: ${error.message}`);
  }
}

function textLineCount(text) {
  if (!text) {
    return 0;
  }
  const lines = text.split(/\r\n|\r|\n/);
  if (/(?:\r\n|\r|\n)$/.test(text)) {
    lines.pop();
  }
  return lines.length;
}

function preferredEol(text) {
  if (text && text.includes('\r\n')) {
    return '\r\n';
  }
  if (text && text.includes('\n')) {
    return '\n';
  }
  return os.EOL;
}

function ruleStateKey(target, workspace) {
  return target.scope === 'project' ? `${target.id}:${workspace}` : target.id;
}

function globalRuleTargets() {
  const home = homeDirectory();
  const dshHome = process.env.DSH_HOME || path.join(home, '.dsh');
  return [
    {
      id: 'claude',
      label: 'Claude Code',
      scope: 'global',
      kind: 'rules',
      file: path.join(home, '.claude', 'CLAUDE.md'),
    },
    {
      id: 'codex',
      label: 'Codex',
      scope: 'global',
      kind: 'rules',
      file: path.join(home, '.codex', 'AGENTS.md'),
    },
    {
      id: 'zcode',
      label: 'ZCode',
      scope: 'global',
      kind: 'rules',
      file: path.join(home, '.zcode', 'AGENTS.md'),
    },
    {
      id: 'agents',
      label: 'Shared agents',
      scope: 'global',
      kind: 'rules',
      file: path.join(home, '.agents', 'AGENTS.md'),
    },
    {
      id: 'dsh',
      label: 'DSH',
      scope: 'global',
      kind: 'rules',
      file: path.join(dshHome, 'AGENTS.md'),
    },
  ].map((target) => ({
    ...target,
    detected: fs.existsSync(path.dirname(target.file)),
  }));
}

function projectRuleTargets(workspace) {
  const agentsFile = path.join(workspace, 'AGENTS.md');
  return [
    {
      id: 'project',
      label: 'Project agents',
      scope: 'project',
      kind: 'rules',
      workspace,
      file: agentsFile,
      detected: true,
    },
    {
      id: 'project-claude',
      label: 'Project Claude import',
      scope: 'project',
      kind: 'import',
      workspace,
      file: path.join(workspace, 'CLAUDE.md'),
      detected: true,
    },
  ];
}

function ruleScope(options) {
  const scope = options.scope || 'global';
  if (!RULE_SCOPES.has(scope)) {
    throw new CliError(EXIT.INVALID, '--scope must be global, project or both');
  }
  return scope;
}

function ruleTargets(options) {
  const scope = ruleScope(options);
  const targets = [];
  if (scope === 'global' || scope === 'both') {
    targets.push(...globalRuleTargets());
  }
  if (scope === 'project' || scope === 'both') {
    const workspace = resolveWorkspace(options.workspace);
    targets.push(...projectRuleTargets(workspace));
  }
  return targets;
}

function selectedRuleTargets(options, targets) {
  const requested = options.only
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length > 0) {
    const known = new Set(targets.map((target) => target.id));
    const unknown = requested.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new CliError(EXIT.INVALID, `unknown rule target: ${unknown.join(', ')}`);
    }
    const wanted = new Set(requested);
    return targets.filter((target) => wanted.has(target.id));
  }
  return targets.filter((target) => target.detected || options.force);
}

function readRuleContent(target) {
  if (!fs.existsSync(target.file)) {
    return null;
  }
  try {
    return fs.readFileSync(target.file, 'utf8');
  } catch (error) {
    throw new CliError(EXIT.UNWRITABLE, `cannot read rule file ${target.file}: ${error.message}`);
  }
}

function ruleBlocks(content, target) {
  if (!content) {
    return [];
  }
  const pattern = /<!--\s*atb:begin[^>]*-->[\s\S]*?<!--\s*atb:end\s*-->/g;
  const blocks = Array.from(content.matchAll(pattern));
  if ((content.includes('atb:begin') || content.includes('atb:end')) && blocks.length !== 1) {
    throw new CliError(
      EXIT.CORRUPT_STATE,
      `rule file must contain exactly one complete atb block: ${target.file}`,
    );
  }
  if (blocks.length > 1) {
    throw new CliError(EXIT.CORRUPT_STATE, `multiple atb blocks found: ${target.file}`);
  }
  return blocks.map((match) => {
    const text = match[0];
    const protocolMatch = text.match(/atb:begin[^>]*\bprotocol\s*:\s*([^\s>]+)/i);
    const nonceMatch = text.match(/\bprobe nonce\s*:\s*([A-Za-z0-9-]+)/i);
    return {
      index: match.index,
      text,
      protocol: protocolMatch ? protocolMatch[1] : null,
      nonce: nonceMatch ? nonceMatch[1] : null,
      sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    };
  });
}

function inspectRuleTarget(target, workspace, state) {
  const content = readRuleContent(target);
  const stateKey = ruleStateKey(target, workspace);
  const stateEntry = state.targets[stateKey] || null;
  if (target.kind === 'import') {
    const installed = content !== null && content.trim() === '@AGENTS.md';
    return {
      target,
      stateKey,
      stateEntry,
      content,
      blocks: [],
      installed,
      protocol: installed ? 'import' : null,
      nonce: null,
      block_sha256: content === null
        ? null
        : crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    };
  }
  const blocks = ruleBlocks(content, target);
  const block = blocks[0] || null;
  return {
    target,
    stateKey,
    stateEntry,
    content,
    blocks,
    installed: Boolean(block),
    protocol: block ? block.protocol : null,
    nonce: block ? block.nonce : null,
    block_sha256: block ? block.sha256 : null,
  };
}

function renderRuleBlock(nonce, eol = os.EOL) {
  return [
    `<!-- ${RULES_PROTOCOL} -->`,
    'AgentTaskBoard may track tasks in this project.',
    '- If `.atb/board.json` does not exist in the current working directory, ignore this block entirely.',
    '- If it exists: run `atb list --since <cursor>` when starting, or when now is later than `next_check_after`.',
    '  Use `atb claim <slug> --actor <name>` to take one, and',
    '  `atb done <slug> --actor <name> --evidence-kind commit|path|test --evidence-ref <ref>` to finish.',
    '- If that claim exits 4 while auto mode is enabled, retry with `--goal`; the retry may create an agent task.',
    '  Deliverable is optional for this claim-time registration, but never treat exit 4 as success.',
    '- Exit codes are authoritative: 3 = owned by someone else, 4 = no such task, 7 = unconfirmed, 10 = workspace unusable.',
    '  Never treat a non-zero exit as success.',
    '- Never edit `.atb/` or any rule file by hand.',
    `- Rule probe nonce: ${nonce}`,
    '<!-- atb:end -->',
  ].join(eol);
}

function ruleInstallPlan(options) {
  const targets = ruleTargets(options);
  const selected = selectedRuleTargets(options, targets);
  const state = readRulesState();
  const workspace = path.resolve(options.workspace || process.cwd());
  const installNonce = crypto.randomUUID();
  const plan = selected.map((target) => {
    const inspected = inspectRuleTarget(target, workspace, state);
    const content = inspected.content;
    const eol = preferredEol(content);
    if (target.kind === 'import') {
      if (content === null) {
        return {
          id: target.id,
          target,
          stateKey: inspected.stateKey,
          action: 'create',
          applicable: true,
          before_lines: 0,
          after_lines: 1,
          next_content: `@AGENTS.md${eol}`,
          created_by_atb: true,
          nonce: null,
          prepend_eol: '',
        };
      }
      return {
        id: target.id,
        target,
        stateKey: inspected.stateKey,
        action: content.trim() === '@AGENTS.md' ? 'unchanged' : 'skip-existing',
        applicable: content.trim() === '@AGENTS.md',
        before_lines: textLineCount(content),
        after_lines: textLineCount(content),
        next_content: content,
        created_by_atb: inspected.stateEntry?.created_by_atb || false,
        nonce: null,
        prepend_eol: '',
        note: content.trim() === '@AGENTS.md'
          ? undefined
          : 'existing CLAUDE.md was not changed; add "@AGENTS.md" manually if needed',
      };
    }

    const nonce = inspected.nonce || inspected.stateEntry?.nonce || installNonce;
    const block = renderRuleBlock(nonce, eol);
    if (content === null) {
      return {
        id: target.id,
        target,
        stateKey: inspected.stateKey,
        action: 'create',
        applicable: true,
        before_lines: 0,
        after_lines: textLineCount(block),
        next_content: block,
        created_by_atb: true,
        nonce,
        prepend_eol: '',
        block_sha256: crypto.createHash('sha256').update(block, 'utf8').digest('hex'),
      };
    }
    if (inspected.blocks.length === 1) {
      const existing = inspected.blocks[0];
      const nextContent =
        content.slice(0, existing.index) +
        block +
        content.slice(existing.index + existing.text.length);
      return {
        id: target.id,
        target,
        stateKey: inspected.stateKey,
        action: nextContent === content ? 'unchanged' : 'replace',
        applicable: nextContent !== content,
        before_lines: textLineCount(content),
        after_lines: textLineCount(nextContent),
        next_content: nextContent,
        created_by_atb: inspected.stateEntry?.created_by_atb || false,
        nonce,
        prepend_eol: inspected.stateEntry?.prepend_eol || '',
        block_sha256: crypto.createHash('sha256').update(block, 'utf8').digest('hex'),
      };
    }
    const prependEol = content.length > 0 && !content.endsWith('\n') ? eol : '';
    const nextContent = `${content}${prependEol}${block}`;
    return {
      id: target.id,
      target,
      stateKey: inspected.stateKey,
      action: 'append',
      applicable: true,
      before_lines: textLineCount(content),
      after_lines: textLineCount(nextContent),
      next_content: nextContent,
      created_by_atb: false,
      nonce,
      prepend_eol: prependEol,
      block_sha256: crypto.createHash('sha256').update(block, 'utf8').digest('hex'),
    };
  });
  return plan;
}

function ruleUninstallPlan(options) {
  const targets = ruleTargets(options);
  const selected = selectedRuleTargets(options, targets);
  const state = readRulesState();
  const workspace = path.resolve(options.workspace || process.cwd());
  return selected.map((target) => {
    const inspected = inspectRuleTarget(target, workspace, state);
    if (target.kind === 'import') {
      const removable =
        inspected.content !== null &&
        inspected.stateEntry?.created_by_atb &&
        inspected.content.trim() === '@AGENTS.md';
      return {
        id: target.id,
        target,
        stateKey: inspected.stateKey,
        action: removable ? 'remove-file' : 'absent',
        applicable: removable,
        before_lines: textLineCount(inspected.content || ''),
        after_lines: 0,
        next_content: null,
      };
    }
    if (!inspected.blocks.length) {
      return {
        id: target.id,
        target,
        stateKey: inspected.stateKey,
        action: 'absent',
        applicable: false,
        before_lines: textLineCount(inspected.content || ''),
        after_lines: textLineCount(inspected.content || ''),
        next_content: inspected.content,
      };
    }
    const block = inspected.blocks[0];
    let start = block.index;
    const entry = inspected.stateEntry;
    if (entry?.prepend_eol && start >= entry.prepend_eol.length) {
      const possiblePrefix = inspected.content.slice(start - entry.prepend_eol.length, start);
      if (possiblePrefix === entry.prepend_eol) {
        start -= entry.prepend_eol.length;
      }
    }
    const nextContent =
      inspected.content.slice(0, start) +
      inspected.content.slice(block.index + block.text.length);
    const removeFile =
      Boolean(entry?.created_by_atb) &&
      (nextContent === '' || nextContent.trim() === '');
    return {
      id: target.id,
      target,
      stateKey: inspected.stateKey,
      action: removeFile ? 'remove-file' : 'remove-block',
      applicable: true,
      before_lines: textLineCount(inspected.content),
      after_lines: textLineCount(nextContent),
      next_content: removeFile ? null : nextContent,
    };
  });
}

function printRulePlan(action, plan, scope, dryRun) {
  process.stdout.write(
    `${action} ${dryRun ? 'plan (dry run)' : 'plan'} (${scope}):\n`,
  );
  if (plan.length === 0) {
    process.stdout.write('  (no matching rule files)\n');
    return;
  }
  for (const item of plan) {
    const note = item.note ? ` - ${item.note}` : '';
    process.stdout.write(
      `  ${item.target.id}: ${item.target.file} ` +
      `[${item.action}; lines ${item.before_lines} -> ${item.after_lines}]${note}\n`,
    );
  }
}

function promptRuleChange(item) {
  process.stdout.write(
    `Apply ${item.action} to ${item.target.file} (${item.before_lines} -> ${item.after_lines} lines)? [y/N] `,
  );
  const buffer = Buffer.alloc(1);
  let answer = '';
  while (true) {
    let read = 0;
    try {
      read = fs.readSync(0, buffer, 0, 1, null);
    } catch (error) {
      if (error.code === 'EAGAIN') {
        pause(10);
        continue;
      }
      throw new CliError(EXIT.INVALID, `cannot read confirmation: ${error.message}`);
    }
    if (read === 0) {
      break;
    }
    const character = buffer.toString('utf8');
    if (character === '\n' || character === '\r') {
      break;
    }
    answer += character;
  }
  const normalized = answer.trim().toLowerCase();
  const accepted = normalized === 'y' || normalized === 'yes';
  process.stdout.write(`${accepted ? 'yes' : 'no'}\n`);
  return accepted;
}

function backupRuleFile(file, stamp) {
  if (!fs.existsSync(file)) {
    return null;
  }
  let backup = `${file}.bak-${stamp}`;
  let suffix = 2;
  while (fs.existsSync(backup)) {
    backup = `${file}.bak-${stamp}-${suffix}`;
    suffix += 1;
  }
  try {
    fs.copyFileSync(file, backup);
    return backup;
  } catch (error) {
    throw new CliError(EXIT.UNWRITABLE, `cannot back up ${file}: ${error.message}`);
  }
}

function writeRuleFile(file, content) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  } catch (error) {
    throw new CliError(EXIT.UNWRITABLE, `cannot write ${file}: ${error.message}`);
  }
}

function removeRuleFile(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new CliError(EXIT.UNWRITABLE, `cannot remove ${file}: ${error.message}`);
    }
  }
}

function manualRuleSteps(scope) {
  const scopeHint = scope === 'project' ? 'project' : 'global';
  return [
    `No files were changed. Add the atb:begin/atb:end block from README.md to each ${scopeHint} rule file you want to connect.`,
    'Back up each file first, then use a fresh agent turn to confirm the rule block is loaded.',
    'Run "atb doctor --rules", ask the agent for its rule probe nonce, then run "atb doctor --rules --expect <answer>".',
  ];
}

function commandRulesInstall(options, positionals) {
  if (positionals.length !== 0 || options.deliverable.length !== 0) {
    throw new CliError(EXIT.INVALID, 'rules install does not take positional arguments');
  }
  const scope = ruleScope(options);
  const plan = ruleInstallPlan(options);
  printRulePlan('rules install', plan, scope, Boolean(options['dry-run']));
  if (options['dry-run']) {
    return {
      exit_code: EXIT.OK,
      ok: true,
      command: 'rules install',
      scope,
      dry_run: true,
      writes: 0,
      state_file: rulesStatePath(),
      plan: plan.map((item) => ({
        id: item.id,
        path: item.target.file,
        action: item.action,
        before_lines: item.before_lines,
        after_lines: item.after_lines,
      })),
    };
  }
  if (plan.every((item) => !item.applicable)) {
    return {
      exit_code: EXIT.OK,
      ok: true,
      command: 'rules install',
      scope,
      changed: 0,
      state_file: rulesStatePath(),
      plan: plan.map((item) => ({ id: item.id, path: item.target.file, action: item.action })),
    };
  }
  if (!options.yes && !process.stdin.isTTY) {
    return {
      exit_code: EXIT.NOT_OWNER,
      ok: false,
      code: EXIT.NOT_OWNER,
      command: 'rules install',
      scope,
      dry_run: false,
      error: 'rule changes were not confirmed',
      manual_steps: manualRuleSteps(scope),
      plan: plan.map((item) => ({
        id: item.id,
        path: item.target.file,
        action: item.action,
        before_lines: item.before_lines,
        after_lines: item.after_lines,
      })),
    };
  }

  const accepted = options.yes
    ? plan.filter((item) => item.applicable)
    : plan.filter((item) => item.applicable && promptRuleChange(item));
  if (accepted.length === 0) {
    return {
      exit_code: EXIT.NOT_OWNER,
      ok: false,
      code: EXIT.NOT_OWNER,
      command: 'rules install',
      scope,
      error: 'no rule changes were confirmed',
      manual_steps: manualRuleSteps(scope),
    };
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const state = readRulesState();
  const backups = [];
  const changed = [];
  for (const item of accepted) {
    const backup = backupRuleFile(item.target.file, stamp);
    if (backup) {
      backups.push(backup);
    }
    if (item.action === 'unchanged') {
      continue;
    }
    writeRuleFile(item.target.file, item.next_content);
    state.targets[item.stateKey] = {
      path: item.target.file,
      scope: item.target.scope,
      kind: item.target.kind,
      created_by_atb: item.created_by_atb,
      block_sha256: item.block_sha256 || null,
      nonce: item.nonce,
      prepend_eol: item.prepend_eol || '',
      installed_at: new Date().toISOString(),
    };
    changed.push(item.id);
  }
  if (changed.length > 0) {
    writeRulesState(state);
  }
  return {
    exit_code: EXIT.OK,
    ok: true,
    command: 'rules install',
    scope,
    dry_run: false,
    changed,
    backups,
    state_file: rulesStatePath(),
  };
}

function commandRulesUninstall(options, positionals) {
  if (positionals.length !== 0 || options.deliverable.length !== 0) {
    throw new CliError(EXIT.INVALID, 'rules uninstall does not take positional arguments');
  }
  const scope = ruleScope(options);
  const plan = ruleUninstallPlan(options);
  printRulePlan('rules uninstall', plan, scope, Boolean(options['dry-run']));
  if (options['dry-run']) {
    return {
      exit_code: EXIT.OK,
      ok: true,
      command: 'rules uninstall',
      scope,
      dry_run: true,
      writes: 0,
      plan: plan.map((item) => ({
        id: item.id,
        path: item.target.file,
        action: item.action,
        before_lines: item.before_lines,
        after_lines: item.after_lines,
      })),
    };
  }
  if (!plan.some((item) => item.applicable)) {
    return {
      exit_code: EXIT.NOT_FOUND,
      ok: false,
      code: EXIT.NOT_FOUND,
      command: 'rules uninstall',
      scope,
      error: 'no installed AgentTaskBoard rules were found',
    };
  }
  if (!options.yes && !process.stdin.isTTY) {
    return {
      exit_code: EXIT.NOT_OWNER,
      ok: false,
      code: EXIT.NOT_OWNER,
      command: 'rules uninstall',
      scope,
      error: 'rule changes were not confirmed',
      manual_steps: ['No files were changed. Re-run with --yes after reviewing the uninstall plan.'],
      plan: plan.map((item) => ({
        id: item.id,
        path: item.target.file,
        action: item.action,
        before_lines: item.before_lines,
        after_lines: item.after_lines,
      })),
    };
  }
  const accepted = options.yes
    ? plan.filter((item) => item.applicable)
    : plan.filter((item) => item.applicable && promptRuleChange(item));
  if (accepted.length === 0) {
    return {
      exit_code: EXIT.NOT_OWNER,
      ok: false,
      code: EXIT.NOT_OWNER,
      command: 'rules uninstall',
      scope,
      error: 'no rule changes were confirmed',
    };
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const state = readRulesState();
  const backups = [];
  const changed = [];
  for (const item of accepted) {
    const backup = backupRuleFile(item.target.file, stamp);
    if (backup) {
      backups.push(backup);
    }
    if (item.action === 'remove-file') {
      removeRuleFile(item.target.file);
    } else {
      writeRuleFile(item.target.file, item.next_content);
    }
    delete state.targets[item.stateKey];
    changed.push(item.id);
  }
  if (changed.length > 0) {
    writeRulesState(state);
  }
  return {
    exit_code: EXIT.OK,
    ok: true,
    command: 'rules uninstall',
    scope,
    dry_run: false,
    changed,
    backups,
    state_file: rulesStatePath(),
  };
}

function commandRulesStatus(options, positionals) {
  if (positionals.length !== 0 || options.deliverable.length !== 0) {
    throw new CliError(EXIT.INVALID, 'rules status does not take positional arguments');
  }
  const scope = ruleScope(options);
  const targets = ruleTargets(options);
  const state = readRulesState();
  const workspace = path.resolve(options.workspace || process.cwd());
  const items = targets.map((target) => {
    const inspected = inspectRuleTarget(target, workspace, state);
    return {
      id: target.id,
      label: target.label,
      path: target.file,
      detected: target.detected,
      installed: inspected.installed,
      protocol: inspected.protocol,
      block_sha256: inspected.block_sha256,
      nonce: inspected.nonce,
      created_by_atb: Boolean(inspected.stateEntry?.created_by_atb),
    };
  });
  const installed = items.filter((item) => item.installed);
  return {
    exit_code: installed.length === items.length ? EXIT.OK : EXIT.NOT_FOUND,
    ok: installed.length === items.length,
    command: 'rules status',
    scope,
    installed_count: installed.length,
    total_count: items.length,
    items,
    state_file: rulesStatePath(),
  };
}

function commandRules(options, positionals) {
  if (positionals.length === 0) {
    throw new CliError(EXIT.INVALID, 'rules requires install, uninstall or status');
  }
  const [action, ...rest] = positionals;
  if (action === 'install') {
    return commandRulesInstall(options, rest);
  }
  if (action === 'uninstall') {
    return commandRulesUninstall(options, rest);
  }
  if (action === 'status') {
    return commandRulesStatus(options, rest);
  }
  throw new CliError(EXIT.INVALID, `unknown rules command: ${action}`);
}

function checkRulesBoard(workspace) {
  const paths = statePaths(workspace);
  if (!fs.existsSync(paths.boardPath)) {
    throw new CliError(
      EXIT.BOARD_UNAVAILABLE,
      `board is not initialized in ${workspace}; run "atb init"`,
    );
  }
  if (fs.existsSync(paths.lockPath)) {
    throw new CliError(EXIT.BOARD_UNAVAILABLE, `board has a lock: ${paths.lockPath}`);
  }
  return readBoard(paths.boardPath);
}

function commandDoctorRules(options, positionals = []) {
  if (positionals.length !== 0 || options.deliverable.length !== 0) {
    throw new CliError(EXIT.INVALID, 'doctor --rules does not take positional arguments');
  }
  const scope = ruleScope(options);
  const targets = ruleTargets(options);
  const state = readRulesState();
  const workspace = path.resolve(options.workspace || process.cwd());
  const inspected = targets.map((target) => inspectRuleTarget(target, workspace, state));
  const installed = inspected.filter((item) => item.installed);
  if (installed.length === 0) {
    return {
      exit_code: EXIT.NOT_FOUND,
      ok: false,
      code: EXIT.NOT_FOUND,
      command: 'doctor --rules',
      scope,
      error: 'AgentTaskBoard rules are not installed',
      manual_steps: ['Run "atb rules install" and confirm the files shown in its plan.'],
    };
  }
  checkRulesBoard(resolveWorkspace(options.workspace));
  const nonces = Array.from(new Set(
    installed
      .flatMap((item) => [item.nonce, item.stateEntry?.nonce])
      .filter(Boolean),
  ));
  const challenge = 'Ask a fresh agent in this project: "What is the AgentTaskBoard rule probe nonce?"';
  if (nonces.length === 0) {
    return {
      exit_code: EXIT.NOT_OWNER,
      ok: false,
      code: EXIT.NOT_OWNER,
      command: 'doctor --rules',
      scope,
      probe: 'missing-nonce',
      error: 'installed rules have no probe nonce',
      manual_steps: ['Run "atb rules install --yes" to refresh the rule block with a probe nonce.'],
      installed_count: installed.length,
    };
  }
  if (options.expect === undefined) {
    return {
      exit_code: EXIT.NOT_OWNER,
      ok: false,
      code: EXIT.NOT_OWNER,
      command: 'doctor --rules',
      scope,
      probe: 'pending',
      challenge,
      next: 'atb doctor --rules --expect <agent-answer>',
      installed_count: installed.length,
      board: 'available',
    };
  }
  const matches = nonces.includes(String(options.expect).trim());
  return {
    exit_code: matches ? EXIT.OK : EXIT.NOT_OWNER,
    ok: matches,
    code: matches ? EXIT.OK : EXIT.NOT_OWNER,
    command: 'doctor --rules',
    scope,
    probe: matches ? 'passed' : 'failed',
    board: 'available',
    installed_count: installed.length,
    ...(matches ? {} : { error: 'the agent answer did not match an installed rule nonce' }),
  };
}

function configureAuto(configPath, enabled, options = {}) {
  const config = readAutoConfig(configPath);
  const now = new Date().toISOString();
  config.auto.enabled = enabled;
  if (options.window !== undefined) {
    config.auto.window_minutes = parseWindow(options.window);
  }
  if (enabled) {
    config.auto.create_allowed = !options['no-create'];
  }
  config.auto.updated_ts = now;
  writeAutoConfig(configPath, config);
  return config;
}

function commandAuto(options, positionals) {
  if (positionals.length !== 1 || !['on', 'off', 'status'].includes(positionals[0])) {
    throw new CliError(EXIT.INVALID, 'auto requires one of: on, off, status');
  }
  const action = positionals[0];
  const workspace = resolveWorkspace(options.workspace);
  const paths = statePaths(workspace);
  if (action === 'status' && !fs.existsSync(paths.boardPath)) {
    throw new CliError(EXIT.NOT_FOUND, `board is not initialized in ${workspace}; run "atb init"`);
  }

  return withBoard(workspace, () => {
    if (action === 'status') {
      const config = readAutoConfig(paths.configPath);
      return {
        ok: true,
        command: 'auto status',
        board_initialized: true,
        auto: autoSnapshot(config),
        exit_code: EXIT.OK,
      };
    }
    const config = configureAuto(paths.configPath, action === 'on', options);
    return {
      ok: true,
      command: `auto ${action}`,
      board_initialized: true,
      auto: autoSnapshot(config),
      exit_code: EXIT.OK,
    };
  });
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
    if (options.auto) {
      configureAuto(paths.configPath, true, options);
    }
  } finally {
    release();
  }

  return {
    ok: true,
    workspace_ref: workspace,
    board: paths.boardPath,
    protocol: PROTOCOL,
    rules_hint: 'run "atb rules install" to connect your agents',
    ...(options.auto ? { auto: autoSnapshot(readAutoConfig(paths.configPath)) } : {}),
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
  let rulesSummary;
  try {
    const targets = globalRuleTargets();
    const state = readRulesState();
    const items = targets.map((target) => {
      const inspected = inspectRuleTarget(target, workspace, state);
      return {
        id: target.id,
        path: target.file,
        installed: inspected.installed,
        probe: inspected.nonce ? 'unknown' : 'missing-nonce',
      };
    });
    rulesSummary = {
      installed_count: items.filter((item) => item.installed).length,
      total_count: items.length,
      items,
    };
  } catch (error) {
    rulesSummary = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let autoSummary;
  try {
    const config = readAutoConfig(paths.configPath);
    autoSummary = {
      ...autoSnapshot(config),
      origins: {
        user: board.tasks.filter((task) => task.origin === 'user').length,
        agent: board.tasks.filter((task) => task.origin === 'agent').length,
      },
    };
  } catch (error) {
    autoSummary = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
    rules: rulesSummary,
    auto: autoSummary,
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
      origin: 'user',
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
  const reference = positionals[0];

  return withBoard(workspace, (board, boardPath) => {
    const paths = statePaths(workspace);
    const config = readAutoConfig(paths.configPath);
    let task = board.tasks.find((item) => item.id === reference || item.slug === reference);
    let created = false;
    let createdSeq = null;
    if (!task) {
      if (!config.auto.enabled || !config.auto.create_allowed) {
        throw new CliError(EXIT.NOT_FOUND, `task not found: ${reference}`);
      }
      const goal = requireValue(options.goal, 'goal');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(reference)) {
        throw new CliError(
          EXIT.INVALID,
          '--slug may contain only letters, numbers, ".", "_" and "-"',
        );
      }
      const deliverables = options.deliverable.map((item) => requireValue(item, 'deliverable'));
      const now = new Date().toISOString();
      task = {
        id: crypto.randomUUID(),
        slug: reference,
        project: options.project ? requireValue(options.project, 'project') : 'default',
        goal,
        workspace_ref: workspace,
        working_subdir: options['working-subdir'] || '',
        deliverables,
        stage: options.stage ? requireValue(options.stage, 'stage') : 'design',
        status: 'todo',
        owner: null,
        outcome: null,
        evidence_kind: null,
        evidence_ref: null,
        origin: 'agent',
        spec_revision: 1,
        created_ts: now,
        updated_ts: now,
      };
      board.tasks.push(task);
      createdSeq = appendEvent(board, task, 'added', {
        actor,
        origin: 'agent',
        goal,
      });
      created = true;
    }
    if (task.status === 'claimed' && task.owner === actor) {
      return {
        ok: true,
        claimed: false,
        created,
        task,
        ...(config.auto.enabled ? { auto: autoSnapshot(config) } : {}),
      };
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
    return {
      ok: true,
      claimed: true,
      created,
      ...(createdSeq === null ? {} : { created_seq: createdSeq }),
      seq,
      run_cwd: runCwd,
      task,
      ...(config.auto.enabled ? { auto: autoSnapshot(config) } : {}),
    };
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
  const origin = options.origin;
  if (origin !== undefined && origin !== 'user' && origin !== 'agent') {
    throw new CliError(EXIT.INVALID, '--origin must be user or agent');
  }

  return withBoard(workspace, (board) => {
    const tasksById = new Map(board.tasks.map((task) => [task.id, task]));
    const tasks = board.tasks.filter((task) => origin === undefined || task.origin === origin);
    const taskIds = new Set(tasks.map((task) => task.id));
    const items = board.events
      .filter((event) => event.seq > since && taskIds.has(event.task_id))
      .map((event) => ({
        ...event,
        task: tasksById.get(event.task_id) || null,
      }));
    const nextCursor =
      items.length > 0 ? items[items.length - 1].seq : since;
    const paths = statePaths(workspace);
    const config = readAutoConfig(paths.configPath);
    return {
      ok: true,
      protocol: PROTOCOL,
      items,
      tasks,
      next_cursor: nextCursor,
      has_more: false,
      auto: autoSnapshot(config),
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
    case 'doctor': {
      if (parsed.options.rules) {
        const result = commandDoctorRules(parsed.options, parsed.positionals);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.exit_code;
      }
      if (parsed.options.expect !== undefined) {
        throw new CliError(EXIT.INVALID, '--expect requires --rules');
      }
      const result = commandDoctor(parsed.options, parsed.positionals);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return EXIT.OK;
    }
    case 'rules': {
      const result = commandRules(parsed.options, parsed.positionals);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.exit_code;
    }
    case 'auto': {
      const result = commandAuto(parsed.options, parsed.positionals);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.exit_code;
    }
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

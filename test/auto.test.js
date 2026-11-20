'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cli = path.resolve(__dirname, '..', 'bin', 'atb.js');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-auto-test-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(root, 'localappdata'),
    XDG_DATA_HOME: path.join(root, 'xdg'),
    DSH_HOME: path.join(home, '.dsh'),
  };
  return { root, home, workspace, env };
}

function run(box, args, options = {}) {
  return childProcess.spawnSync(
    process.execPath,
    [cli, ...args],
    {
      cwd: box.workspace,
      env: box.env,
      encoding: 'utf8',
      input: options.input || '',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

function parseJson(result) {
  return JSON.parse(result.stdout || result.stderr);
}

function runAsync(box, args) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(
      process.execPath,
      [cli, ...args],
      {
        cwd: box.workspace,
        env: box.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function readFile(file) {
  return fs.readFileSync(file, 'utf8');
}

function fileHash(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function blockCount(content) {
  return (content.match(/<!--\s*atb:begin/g) || []).length;
}

function stripBlock(content) {
  return content.replace(
    /<!--\s*atb:begin[^>]*-->[\s\S]*?<!--\s*atb:end\s*-->/g,
    '',
  );
}

function initBoard(box) {
  const result = run(box, ['init', '--workspace', box.workspace]);
  assert.equal(result.status, 0, result.stderr);
}

test('auto status reports off before and after init, and on exposes the next check', () => {
  const box = makeSandbox();
  const before = run(box, ['auto', 'status', '--workspace', box.workspace]);
  assert.equal(before.status, 4, before.stderr);

  initBoard(box);
  const off = run(box, ['auto', 'status', '--workspace', box.workspace]);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(parseJson(off).auto.enabled, false);
  assert.equal(parseJson(off).auto.next_check_after, null);
  assert.equal(parseJson(off).board_initialized, true);

  const on = run(box, ['auto', 'on', '--window', '7m', '--workspace', box.workspace]);
  assert.equal(on.status, 0, on.stderr);
  const onJson = parseJson(on);
  assert.equal(onJson.auto.enabled, true);
  assert.equal(onJson.auto.window_minutes, 7);
  assert.equal(onJson.auto.create_allowed, true);
  assert.equal(typeof onJson.auto.next_check_after, 'string');
  assert.equal(fs.existsSync(path.join(box.workspace, '.atb', 'config.json')), true);

  const offAgain = run(box, ['auto', 'off', '--workspace', box.workspace]);
  assert.equal(offAgain.status, 0, offAgain.stderr);
  assert.equal(parseJson(offAgain).auto.enabled, false);
  assert.equal(parseJson(offAgain).auto.next_check_after, null);
});

test('claim preserves v0.1 not-found behavior when auto is off', () => {
  const box = makeSandbox();
  initBoard(box);

  const result = run(
    box,
    ['claim', 'missing-task', '--actor', 'builder', '--goal', 'do it', '--workspace', box.workspace],
  );
  assert.equal(result.status, 4, result.stderr);
  const board = JSON.parse(readFile(path.join(box.workspace, '.atb', 'board.json')));
  assert.equal(board.tasks.length, 0);
});

test('--no-create keeps auto sync enabled but blocks claim-time registration', () => {
  const box = makeSandbox();
  initBoard(box);

  const enabled = run(
    box,
    ['auto', 'on', '--no-create', '--workspace', box.workspace],
  );
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.equal(parseJson(enabled).auto.enabled, true);
  assert.equal(parseJson(enabled).auto.create_allowed, false);

  const result = run(
    box,
    ['claim', 'blocked-task', '--actor', 'builder', '--goal', 'do not create', '--workspace', box.workspace],
  );
  assert.equal(result.status, 4, result.stderr);
  assert.deepEqual(
    JSON.parse(readFile(path.join(box.workspace, '.atb', 'board.json'))).tasks,
    [],
  );
});

test('claim requires a goal and creates an agent task when auto is on', () => {
  const box = makeSandbox();
  initBoard(box);
  run(box, ['auto', 'on', '--workspace', box.workspace]);

  const missingGoal = run(
    box,
    ['claim', 'agent-task', '--actor', 'builder', '--workspace', box.workspace],
  );
  assert.equal(missingGoal.status, 5, missingGoal.stderr);
  assert.deepEqual(
    JSON.parse(readFile(path.join(box.workspace, '.atb', 'board.json'))).tasks,
    [],
  );

  const claimed = run(
    box,
    ['claim', 'agent-task', '--actor', 'builder', '--goal', 'ship the fix', '--workspace', box.workspace],
  );
  assert.equal(claimed.status, 0, claimed.stderr);
  const result = parseJson(claimed);
  assert.equal(result.created, true);
  assert.equal(result.task.origin, 'agent');
  assert.deepEqual(result.task.deliverables, []);
  assert.equal(result.task.status, 'claimed');
  assert.equal(result.task.owner, 'builder');
  assert.equal(result.auto.enabled, true);
  assert.equal(typeof result.auto.next_check_after, 'string');
});

test('an existing task is claimed normally and ignores claim-time goal', () => {
  const box = makeSandbox();
  initBoard(box);
  const added = run(box, [
    'add',
    '--slug', 'human-task',
    '--goal', 'human goal',
    '--deliverable', 'README.md',
    '--workspace', box.workspace,
  ]);
  assert.equal(added.status, 0, added.stderr);
  run(box, ['auto', 'on', '--workspace', box.workspace]);

  const claimed = run(
    box,
    ['claim', 'human-task', '--actor', 'builder', '--goal', 'ignored goal', '--workspace', box.workspace],
  );
  assert.equal(claimed.status, 0, claimed.stderr);
  const result = parseJson(claimed);
  assert.equal(result.created, false);
  assert.equal(result.task.origin, 'user');
  assert.equal(result.task.goal, 'human goal');
});

test('list filters by origin and doctor reports auto mode with origin counts', () => {
  const box = makeSandbox();
  initBoard(box);
  const added = run(box, [
    'add',
    '--slug', 'human-task',
    '--goal', 'human goal',
    '--deliverable', 'README.md',
    '--workspace', box.workspace,
  ]);
  assert.equal(added.status, 0, added.stderr);
  run(box, ['auto', 'on', '--workspace', box.workspace]);
  const created = run(box, [
    'claim', 'agent-task',
    '--actor', 'builder',
    '--goal', 'agent goal',
    '--workspace', box.workspace,
  ]);
  assert.equal(created.status, 0, created.stderr);

  const configPath = path.join(box.workspace, '.atb', 'config.json');
  const configHash = fileHash(configPath);
  const configMtime = fs.statSync(configPath).mtimeMs;
  const users = run(box, ['list', '--origin', 'user', '--workspace', box.workspace]);
  assert.equal(users.status, 0, users.stderr);
  assert.deepEqual(parseJson(users).tasks.map((task) => task.slug), ['human-task']);

  const agents = run(box, ['list', '--origin', 'agent', '--workspace', box.workspace]);
  assert.equal(agents.status, 0, agents.stderr);
  assert.deepEqual(parseJson(agents).tasks.map((task) => task.slug), ['agent-task']);
  assert.equal(typeof parseJson(agents).auto.next_check_after, 'string');
  assert.equal(fileHash(configPath), configHash);
  assert.equal(fs.statSync(configPath).mtimeMs, configMtime);

  const doctor = run(box, ['doctor', '--workspace', box.workspace]);
  assert.equal(doctor.status, 0, doctor.stderr);
  const summary = parseJson(doctor).auto;
  assert.equal(summary.enabled, true);
  assert.deepEqual(summary.origins, { user: 1, agent: 1 });
});

test('concurrent claims create one task and one owner', async () => {
  const box = makeSandbox();
  initBoard(box);
  run(box, ['auto', 'on', '--workspace', box.workspace]);
  const base = [
    'claim', 'parallel-task',
    '--goal', 'parallel work', '--workspace', box.workspace,
  ];

  const results = await Promise.all([
    runAsync(box, [...base, '--actor', 'builder']),
    runAsync(box, [...base, '--actor', 'reviewer']),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [0, 3]);
  const board = JSON.parse(readFile(path.join(box.workspace, '.atb', 'board.json')));
  assert.equal(board.tasks.length, 1);
  assert.equal(board.tasks[0].origin, 'agent');
});

test('rules install upgrades protocol 1 blocks to protocol 2 without changing bytes outside them', () => {
  const box = makeSandbox();
  const realHome = process.env.USERPROFILE || os.homedir();
  const realTargets = [
    path.join(realHome, '.claude', 'CLAUDE.md'),
    path.join(realHome, '.codex', 'AGENTS.md'),
    path.join(realHome, '.zcode', 'AGENTS.md'),
    path.join(realHome, '.agents', 'AGENTS.md'),
    path.join(process.env.DSH_HOME || path.join(realHome, '.dsh'), 'AGENTS.md'),
  ];
  const realHashes = realTargets.map(fileHash);
  const targets = [
    path.join(box.home, '.claude', 'CLAUDE.md'),
    path.join(box.home, '.codex', 'AGENTS.md'),
    path.join(box.home, '.zcode', 'AGENTS.md'),
    path.join(box.home, '.agents', 'AGENTS.md'),
    path.join(box.env.DSH_HOME, 'AGENTS.md'),
  ];
  const oldBlock = [
    '<!-- atb:begin protocol:1 -->',
    'before',
    '<!-- atb:end -->',
  ].join(os.EOL);
  for (const [index, file] of targets.entries()) {
    writeFile(file, `user ${index}${os.EOL}${oldBlock}${os.EOL}tail ${index}`);
  }
  initBoard(box);

  const installed = run(box, ['rules', 'install', '--scope', 'global', '--yes']);
  assert.equal(installed.status, 0, installed.stderr);
  for (const file of targets) {
    const content = readFile(file);
    assert.equal(blockCount(content), 1);
    assert.match(content, /atb:begin protocol:2/);
    const backup = fs.readdirSync(path.dirname(file))
      .filter((name) => name.startsWith(`${path.basename(file)}.bak-`))
      .sort()
      .pop();
    assert.ok(backup, `missing backup for ${file}`);
    const previous = readFile(path.join(path.dirname(file), backup));
    assert.equal(stripBlock(content), stripBlock(previous));
  }
  assert.deepEqual(realTargets.map(fileHash), realHashes);
});

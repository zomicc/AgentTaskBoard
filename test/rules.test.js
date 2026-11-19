'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cli = path.resolve(__dirname, '..', 'bin', 'atb.js');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-rules-test-'));
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

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function readFile(file) {
  return fs.readFileSync(file, 'utf8');
}

function blockCount(content) {
  return (content.match(/<!--\s*atb:begin/g) || []).length;
}

function ruleFile(box, relative) {
  return path.join(box.home, relative);
}

function stateFile(box) {
  return path.join(box.root, 'localappdata', 'atb', 'rules.json');
}

function makeCodexFile(box, content) {
  const file = ruleFile(box, '.codex/AGENTS.md');
  writeFile(file, content);
  return file;
}

function initBoard(box) {
  const result = run(box, ['init', '--workspace', box.workspace]);
  assert.equal(result.status, 0, result.stderr);
}

test('dry-run changes neither rule files nor mtime and creates no state', () => {
  const box = makeSandbox();
  const file = makeCodexFile(box, 'keep this line\n');
  const before = readFile(file);
  const beforeMtime = fs.statSync(file).mtimeMs;

  const result = run(box, ['rules', 'install', '--only', 'codex', '--dry-run']);

  assert.equal(result.status, 0);
  assert.equal(readFile(file), before);
  assert.equal(fs.statSync(file).mtimeMs, beforeMtime);
  assert.equal(fs.existsSync(stateFile(box)), false);
  assert.equal(blockCount(before), 0);
});

test('non-TTY unconfirmed install exits 7, and --yes is idempotent', () => {
  const box = makeSandbox();
  const original = 'my own instructions\nsecond line\n';
  const file = makeCodexFile(box, original);

  const unconfirmed = run(box, ['rules', 'install', '--only', 'codex']);
  assert.equal(unconfirmed.status, 7);
  assert.equal(readFile(file), original);
  assert.equal(fs.existsSync(stateFile(box)), false);

  const installed = run(box, ['rules', 'install', '--only', 'codex', '--yes']);
  assert.equal(installed.status, 0, installed.stderr);
  const afterFirst = readFile(file);
  assert.equal(blockCount(afterFirst), 1);
  assert.equal(afterFirst.slice(0, original.length), original);

  const second = run(box, ['rules', 'install', '--only', 'codex', '--yes']);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFile(file), afterFirst);
  assert.equal(blockCount(readFile(file)), 1);
});

test('install and uninstall preserve bytes outside the block', () => {
  const box = makeSandbox();
  const original = 'alpha\r\nbeta\r\ngamma';
  const file = makeCodexFile(box, original);

  const installed = run(box, ['rules', 'install', '--only', 'codex', '--yes']);
  assert.equal(installed.status, 0, installed.stderr);
  const installedText = readFile(file);
  assert.equal(installedText.slice(0, original.length), original);
  assert.equal(blockCount(installedText), 1);

  const uninstalled = run(box, ['rules', 'uninstall', '--only', 'codex', '--yes']);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(readFile(file), original);
});

test('uninstall deletes a file created by the rules installer', () => {
  const box = makeSandbox();
  const file = ruleFile(box, '.claude/CLAUDE.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const installed = run(box, ['rules', 'install', '--only', 'claude', '--yes']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.existsSync(file), true);

  const uninstalled = run(box, ['rules', 'uninstall', '--only', 'claude', '--yes']);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(fs.existsSync(file), false);
});

test('project scope installs AGENTS.md and a missing CLAUDE import', () => {
  const box = makeSandbox();
  initBoard(box);
  const agents = path.join(box.workspace, 'AGENTS.md');
  const claude = path.join(box.workspace, 'CLAUDE.md');
  writeFile(agents, 'project rules\n');

  const installed = run(box, ['rules', 'install', '--scope', 'project', '--yes']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(blockCount(readFile(agents)), 1);
  assert.equal(readFile(claude), '@AGENTS.md' + os.EOL);

  const uninstalled = run(box, ['rules', 'uninstall', '--scope', 'project', '--yes']);
  assert.equal(uninstalled.status, 0, uninstalled.stderr);
  assert.equal(readFile(agents), 'project rules\n');
  assert.equal(fs.existsSync(claude), false);
});

test('doctor --rules maps not-installed, pending, passed, and board unavailable to 4/7/0/6', () => {
  const box = makeSandbox();
  const file = makeCodexFile(box, 'existing\n');

  const notInstalled = run(box, ['doctor', '--rules', '--workspace', box.workspace]);
  assert.equal(notInstalled.status, 4, notInstalled.stderr);

  initBoard(box);
  const pending = run(box, ['doctor', '--rules', '--workspace', box.workspace]);
  assert.equal(pending.status, 4, pending.stderr);

  const installed = run(box, ['rules', 'install', '--only', 'codex', '--yes']);
  assert.equal(installed.status, 0, installed.stderr);
  const probePending = run(box, ['doctor', '--rules', '--workspace', box.workspace]);
  assert.equal(probePending.status, 7, probePending.stderr);
  const nonce = readFile(file).match(/\bprobe nonce:\s*([A-Za-z0-9-]+)/i)[1];
  const passed = run(box, ['doctor', '--rules', '--workspace', box.workspace, '--expect', nonce]);
  assert.equal(passed.status, 0, passed.stderr);

  fs.rmSync(path.join(box.workspace, '.atb'), { recursive: true, force: true });
  const unavailable = run(box, ['doctor', '--rules', '--workspace', box.workspace]);
  assert.equal(unavailable.status, 6, unavailable.stderr);
});

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atb-board-test-'));
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

function run(box, args) {
  return childProcess.spawnSync(
    process.execPath,
    [cli, ...args],
    {
      cwd: box.workspace,
      env: box.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function initBoard(box) {
  const result = run(box, ['init', '--workspace', box.workspace]);
  assert.equal(result.status, 0, result.stderr);
}

function fileSnapshot(file) {
  const stat = fs.statSync(file);
  return {
    hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function startBoard(box) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(
      process.execPath,
      [cli, 'board', '--port', '0', '--no-open', '--workspace', box.workspace],
      {
        cwd: box.workspace,
        env: box.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error(`board did not start\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    }, 10_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (settled) {
        return;
      }
      const line = stdout.split(/\r?\n/).find((item) => item.startsWith('{'));
      if (!line) {
        return;
      }
      try {
        const info = JSON.parse(line);
        if (info.url) {
          settled = true;
          clearTimeout(timeout);
          resolve({ child, info });
        }
      } catch {
        // Wait for the complete startup line.
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`board exited before startup with ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
    });
  });
}

function stopBoard(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

test('board serves the UI and a read-only API without changing state files', async () => {
  const box = makeSandbox();
  initBoard(box);

  const human = run(box, [
    'add',
    '--slug', 'human-task',
    '--goal', 'human task',
    '--deliverable', 'README.md',
    '--workspace', box.workspace,
  ]);
  assert.equal(human.status, 0, human.stderr);
  const auto = run(box, ['auto', 'on', '--workspace', box.workspace]);
  assert.equal(auto.status, 0, auto.stderr);
  const agent = run(box, [
    'claim', 'agent-task',
    '--actor', 'builder',
    '--goal', 'agent task',
    '--workspace', box.workspace,
  ]);
  assert.equal(agent.status, 0, agent.stderr);

  const boardPath = path.join(box.workspace, '.atb', 'board.json');
  const configPath = path.join(box.workspace, '.atb', 'config.json');
  const before = {
    board: fileSnapshot(boardPath),
    config: fileSnapshot(configPath),
  };
  const server = await startBoard(box);

  try {
    const page = await fetch(`${server.info.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /^text\/html/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const html = await page.text();
    assert.match(html, /AgentTaskBoard/);
    assert.match(html, /\/api\/board/);

    const first = await fetch(`${server.info.url}/api/board`);
    assert.equal(first.status, 200);
    const payload = await first.json();
    assert.equal(payload.protocol, 'agenttaskboard-protocol: 1');
    assert.equal(payload.tasks.length, 2);
    assert.deepEqual(payload.tasks.map((task) => task.slug).sort(), ['agent-task', 'human-task']);
    assert.equal(payload.auto.enabled, true);
    assert.equal(typeof payload.auto.next_check_after, 'string');
    assert.equal(typeof payload.generated_at, 'string');

    const second = await fetch(`${server.info.url}/api/board`, { cache: 'no-store' });
    assert.equal(second.status, 200);
    await second.json();

    const post = await fetch(`${server.info.url}/api/board`, { method: 'POST' });
    assert.equal(post.status, 404);
    const unknown = await fetch(`${server.info.url}/missing`);
    assert.equal(unknown.status, 404);
  } finally {
    await stopBoard(server.child);
  }

  assert.deepEqual(fileSnapshot(boardPath), before.board);
  assert.deepEqual(fileSnapshot(configPath), before.config);
});

test('board requires an initialized board and rejects an invalid port', () => {
  const box = makeSandbox();
  const missing = run(box, ['board', '--port', '0', '--no-open', '--workspace', box.workspace]);
  assert.equal(missing.status, 6, missing.stderr);
  assert.match(missing.stderr, /board is not initialized/);

  initBoard(box);
  const invalid = run(box, ['board', '--port', '70000', '--no-open', '--workspace', box.workspace]);
  assert.equal(invalid.status, 5, invalid.stderr);
  assert.match(invalid.stderr, /--port must be an integer from 0 to 65535/);
});

#!/usr/bin/env node
'use strict';

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { WebSocket } = require('ws');
const crypto = require('crypto');

const {
  PROTOCOL_VERSION,
  MessageType,
  TaskAction,
  createMessage,
  parseMessage,
  validateAgentMessage,
  HEARTBEAT_INTERVAL,
  TASK_TIMEOUT,
} = require('./lib/agent-protocol');

// Minimale .env-lader (geen dotenv-dependency). Alleen instellen als de variabele
// nog niet in de echte omgeving staat, zodat expliciete env-vars voorrang houden.
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    }
  }
} catch (e) { /* .env is optioneel */ }

const GIT_TIMEOUT = parseInt(process.env.GIT_TIMEOUT || '15000', 10);
const GIT_LONG_TIMEOUT = parseInt(process.env.GIT_LONG_TIMEOUT || '30000', 10);
const GIT_USER_EMAIL = 'mindframework@auto.sync';
const GIT_USER_NAME = 'MindFramework Auto-Sync';

let coordinatorUrl = process.env.COORDINATOR_URL || 'http://localhost:3050';
let nodeKey = process.env.NODE_KEY;
let nodeId = null;
let ws = null;
let heartbeatTimer = null;
let currentTask = null;
let taskTimeout = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 5000;

function log(level, msg, data) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  if (data) {
    console.log(`${prefix} ${msg}`, JSON.stringify(data));
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

function tokenize(cmd) {
  const args = [];
  let i = 0;
  const len = cmd.length;
  while (i < len) {
    while (i < len && /\s/.test(cmd[i])) i++;
    if (i >= len) break;
    let token = '';
    let quote = null;
    while (i < len) {
      const ch = cmd[i];
      if (quote) {
        if (ch === quote) {
          quote = null;
          i++;
          continue;
        }
        token += ch;
        i++;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        i++;
      } else if (/\s/.test(ch)) {
        break;
      } else {
        token += ch;
        i++;
      }
    }
    args.push(token);
  }
  return args;
}

function buildAuthArgs(token) {
  if (!token) return [];
  const auth = Buffer.from(`${token}:x-oauth-basic`).toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${auth}`];
}

function gitSync(cmd, cwd, timeout, token) {
  const args = Array.isArray(cmd) ? cmd.slice() : tokenize(String(cmd));
  if (token) args.unshift(...buildAuthArgs(token));
  try {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: timeout || GIT_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    return {
      success: result.status === 0 && !result.error,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
      code: result.status,
    };
  } catch (err) {
    return { success: false, stdout: '', stderr: err.message, code: -1 };
  }
}

async function gitAsync(cmd, cwd, timeout, token) {
  return new Promise((resolve) => {
    const args = Array.isArray(cmd) ? cmd.slice() : tokenize(String(cmd));
    if (token) args.unshift(...buildAuthArgs(token));
    const proc = spawn('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: timeout || GIT_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => resolve({
      success: code === 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      code,
    }));
    proc.on('error', (err) => resolve({ success: false, stdout: '', stderr: err.message, code: -1 }));
  });
}

function isGitRepo(dir) {
  if (!dir || typeof dir !== 'string') return false;
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function getBranch(repoPath, token) {
  const result = gitSync('rev-parse --abbrev-ref HEAD', repoPath, GIT_TIMEOUT, token);
  return result.success ? result.stdout : 'main';
}

function hasUncommittedChanges(repoPath, token) {
  const result = gitSync('status --porcelain', repoPath, GIT_TIMEOUT, token);
  return result.success && result.stdout.length > 0;
}

function cleanRemoteUrl(remoteRaw) {
  if (!remoteRaw) return '';
  return remoteRaw
    .replace(/https:\/\/[^@]+@github\.com\//, 'github.com/')
    .replace(/\.git$/, '');
}

async function ensureRepoPresent(payload, emitProgress) {
  const { repoPath, remote, token } = payload;
  const remoteUrl = `https://github.com/${remote}.git`;

  if (fs.existsSync(repoPath) && !isGitRepo(repoPath)) {
    return { error: `Path exists but is not a git repository: ${repoPath}` };
  }

  if (!isGitRepo(repoPath)) {
    emitProgress(`Cloning ${remote} into ${repoPath}...`, 'info');
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    const clone = gitSync(['clone', remoteUrl, repoPath], process.cwd(), GIT_LONG_TIMEOUT, token);
    if (!clone.success) {
      return { error: 'Clone failed', details: clone.stderr };
    }
    emitProgress('Clone completed', 'success');
  }

  const existingRemote = gitSync('remote get-url origin', repoPath, GIT_TIMEOUT, token);
  const normalized = (u) => String(u || '').replace(/\.git$/, '');
  if (!existingRemote.success || !existingRemote.stdout) {
    const addRemote = gitSync(['remote', 'add', 'origin', remoteUrl], repoPath, GIT_TIMEOUT, token);
    if (!addRemote.success) {
      return { error: 'Failed to add remote', details: addRemote.stderr };
    }
  } else if (existingRemote.stdout.includes('@') || normalized(existingRemote.stdout) !== normalized(remoteUrl)) {
    const setRemote = gitSync(['remote', 'set-url', 'origin', remoteUrl], repoPath, GIT_TIMEOUT, token);
    if (!setRemote.success) {
      return { error: 'Failed to update remote URL', details: setRemote.stderr };
    }
  }

  return null;
}

async function executeSyncTask(payload) {
  const { repoId, repoName, repoPath, remote, token, githubUser, commitMessage, action, syncDirection } = payload;

  const logs = [];

  const emitProgress = (msg, type = 'info') => {
    logs.push({ msg, type, timestamp: Date.now() });
    sendMessage(MessageType.TASK_PROGRESS, { repoId, msg, type, logs });
  };

  try {
    const prep = await ensureRepoPresent(payload, emitProgress);
    if (prep) {
      return { success: false, ...prep, logs };
    }

    gitSync(['config', 'user.email', GIT_USER_EMAIL], repoPath, GIT_TIMEOUT, token);
    gitSync(['config', 'user.name', GIT_USER_NAME], repoPath, GIT_TIMEOUT, token);

    const branch = getBranch(repoPath, token);

    const doFetch = action === TaskAction.SYNC || action === TaskAction.FETCH || action === TaskAction.CLONE;
    const doPull = (action === TaskAction.SYNC || action === TaskAction.PULL || action === TaskAction.CLONE) && syncDirection !== 'push';
    const doPush = (action === TaskAction.SYNC || action === TaskAction.PUSH || action === TaskAction.CLONE) && syncDirection !== 'pull';

    if (doFetch) {
      emitProgress(`Fetching from origin...`, 'info');
      const fetchResult = gitSync('fetch origin', repoPath, GIT_LONG_TIMEOUT, token);
      if (!fetchResult.success) {
        return { success: false, error: 'Fetch failed', details: fetchResult.stderr, logs };
      }
      emitProgress(`Fetch completed`, 'success');
    }

    if (doPull) {
      const behindResult = gitSync(`rev-list --count ${branch}..origin/${branch}`, repoPath, GIT_TIMEOUT, token);
      const behindCount = behindResult.success ? parseInt(behindResult.stdout || '0', 10) : 0;

      if (behindCount > 0) {
        emitProgress(`Pulling ${behindCount} commits from remote...`, 'info');
        let pullResult = gitSync(['pull', '--no-edit', '--no-rebase', 'origin', branch], repoPath, GIT_LONG_TIMEOUT, token);
        if (!pullResult.success) {
          pullResult = gitSync(['pull', '--allow-unrelated-histories', '--no-edit', '--no-rebase', 'origin', branch], repoPath, GIT_LONG_TIMEOUT, token);
        }
        if (!pullResult.success) {
          const conflictFiles = gitSync(['diff', '--name-only', '--diff-filter=U'], repoPath, GIT_TIMEOUT, token);
          if (conflictFiles.success && conflictFiles.stdout) {
            gitSync(['merge', '--abort'], repoPath, GIT_TIMEOUT, token);
            sendMessage(MessageType.CONFLICT_DETECTED, { repoId, files: conflictFiles.stdout.split('\n').filter(Boolean) });
            return { success: false, error: 'Merge conflict', conflictFiles: conflictFiles.stdout.split('\n').filter(Boolean), logs };
          }
          return { success: false, error: 'Pull failed', details: pullResult.stderr, logs };
        }
        emitProgress(`Merged ${behindCount} commits`, 'success');
      }
    }

    if (doPush) {
      const aheadResult = gitSync(`rev-list --count origin/${branch}..${branch}`, repoPath, GIT_TIMEOUT, token);
      const aheadCount = aheadResult.success ? parseInt(aheadResult.stdout || '0', 10) : 0;

      const hasChanges = hasUncommittedChanges(repoPath, token);
      if (hasChanges) {
        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const msg = commitMessage || `auto-sync: ${now}`;
        gitSync(['add', '-A'], repoPath, GIT_TIMEOUT, token);
        const commitResult = gitSync(['commit', '-m', msg], repoPath, GIT_TIMEOUT, token);
        if (commitResult.success) {
          emitProgress(`Committed: ${msg}`, 'success');
        }
      }

      const aheadAfterResult = gitSync(`rev-list --count origin/${branch}..${branch}`, repoPath, GIT_TIMEOUT, token);
      const aheadAfterCount = aheadAfterResult.success ? parseInt(aheadAfterResult.stdout || '0', 10) : 0;

      if (aheadAfterCount > 0) {
        emitProgress(`Pushing ${aheadAfterCount} commits...`, 'info');
        const pushResult = gitSync(['push', 'origin', branch], repoPath, GIT_LONG_TIMEOUT, token);
        if (!pushResult.success) {
          return { success: false, error: 'Push failed', details: pushResult.stderr, logs };
        }
        emitProgress(`Pushed ${aheadAfterCount} commits`, 'success');
      }
    }

    const status = await getRepoStatusInternal(repoPath, token, remote);
    return { success: true, status, logs };

  } catch (err) {
    return { success: false, error: err.message, logs };
  }
}

async function executeCreateTask(payload) {
  const { repoId, repoName, repoPath, remote, token, githubUser, description } = payload;
  const remoteUrl = `https://github.com/${remote}.git`;

  if (fs.existsSync(repoPath) && isGitRepo(repoPath)) {
    return { success: false, error: `Repository already exists at: ${repoPath}` };
  }

  try {
    fs.mkdirSync(repoPath, { recursive: true });
    if (fs.readdirSync(repoPath).length === 0) {
      fs.writeFileSync(path.join(repoPath, 'README.md'), `# ${repoName}\n\n${description || ''}\n`);
    }

    const init = gitSync(['init'], repoPath, GIT_TIMEOUT, token);
    if (!init.success) return { success: false, error: 'git init failed', details: init.stderr };

    gitSync(['config', 'user.email', GIT_USER_EMAIL], repoPath, GIT_TIMEOUT, token);
    gitSync(['config', 'user.name', GIT_USER_NAME], repoPath, GIT_TIMEOUT, token);

    const addRemote = gitSync(['remote', 'add', 'origin', remoteUrl], repoPath, GIT_TIMEOUT, token);
    if (!addRemote.success) return { success: false, error: 'Failed to add remote', details: addRemote.stderr };

    const add = gitSync(['add', '-A'], repoPath, GIT_TIMEOUT, token);
    if (!add.success) return { success: false, error: 'git add failed', details: add.stderr };

    const commit = gitSync(['commit', '-m', 'Initial commit'], repoPath, GIT_TIMEOUT, token);
    if (!commit.success) return { success: false, error: 'Initial commit failed', details: commit.stderr };

    const branch = getBranch(repoPath, token);
    const push = gitSync(['push', '-u', 'origin', branch], repoPath, GIT_LONG_TIMEOUT, token);
    if (!push.success) return { success: false, error: 'Push failed', details: push.stderr };

    const status = await getRepoStatusInternal(repoPath, token, remote);
    return { success: true, status, branch };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getRepoStatusInternal(repoPath, token, remote) {
  if (!isGitRepo(repoPath)) {
    return { status: 'no-git', changes: 0, behindCount: 0, aheadCount: 0, branch: '', remote: '' };
  }

  const statusResult = gitSync('status --porcelain', repoPath, GIT_TIMEOUT, token);
  const changes = statusResult.success ? statusResult.stdout.split('\n').filter(Boolean).length : 0;

  const branch = getBranch(repoPath, token);
  const cleanRemote = cleanRemoteUrl(remote);

  let behindCount = 0, aheadCount = 0;

  const fetchResult = gitSync('fetch origin', repoPath, GIT_LONG_TIMEOUT, token);
  if (fetchResult.success) {
    const behind = gitSync(`rev-list --count ${branch}..origin/${branch}`, repoPath, GIT_TIMEOUT, token);
    const ahead = gitSync(`rev-list --count origin/${branch}..${branch}`, repoPath, GIT_TIMEOUT, token);
    if (behind.success) behindCount = parseInt(behind.stdout || '0', 10);
    if (ahead.success) aheadCount = parseInt(ahead.stdout || '0', 10);
  }

  let statusKey = 'clean';
  if (changes > 0 && behindCount > 0) statusKey = 'both';
  else if (changes > 0) statusKey = 'changes';
  else if (behindCount > 0) statusKey = 'behind';

  return { status: statusKey, changes, behindCount, aheadCount, branch, remote: cleanRemote };
}

async function executeStatusTask(payload) {
  const { repoId, repoPath, remote, token } = payload;
  const status = await getRepoStatusInternal(repoPath, token, remote);
  return { success: true, status };
}

async function executeBranchesTask(payload) {
  const { repoId, repoPath, token } = payload;
  const result = gitSync('branch -a', repoPath, GIT_TIMEOUT, token);
  const branches = result.success ? result.stdout.split('\n').map(b => b.replace(/^\*?\s*/, '').trim()).filter(Boolean) : [];
  const current = getBranch(repoPath, token);
  return { success: true, branches, current };
}

async function executeSwitchBranchTask(payload) {
  const { repoId, repoPath, token, branch } = payload;
  const result = gitSync(['checkout', branch], repoPath, GIT_LONG_TIMEOUT, token);
  if (!result.success) {
    return { success: false, error: `Failed to switch to ${branch}`, details: result.stderr };
  }
  const current = getBranch(repoPath, token);
  return { success: true, current };
}

async function executeResolveConflictTask(payload) {
  const { repoId, repoPath, token, strategy } = payload;
  const branch = getBranch(repoPath, token);

  gitSync('fetch origin', repoPath, GIT_LONG_TIMEOUT, token);

  if (strategy === 'abort') {
    gitSync(['merge', '--abort'], repoPath, GIT_TIMEOUT, token);
    return { success: true, aborted: true, current: getBranch(repoPath, token) };
  }

  if (hasUncommittedChanges(repoPath, token)) {
    gitSync(['add', '-A'], repoPath, GIT_TIMEOUT, token);
    gitSync(['commit', '-m', 'auto-sync: resolve'], repoPath, GIT_TIMEOUT, token);
  }

  let mergeResult = gitSync(['merge', '--allow-unrelated-histories', '-s', 'recursive', '-X', strategy, '--no-edit', `origin/${branch}`], repoPath, GIT_LONG_TIMEOUT, token);

  if (!mergeResult.success) {
    const unmerged = gitSync('diff --name-only --diff-filter=U', repoPath, GIT_TIMEOUT, token);
    if (!unmerged.success || !unmerged.stdout) {
      gitSync(['merge', '--abort'], repoPath, GIT_TIMEOUT, token);
      return { success: false, error: 'Could not auto-resolve conflict' };
    }

    for (const file of unmerged.stdout.split('\n').map(f => f.trim()).filter(Boolean)) {
      const statusLine = gitSync(`status --porcelain -- ${file}`, repoPath, GIT_TIMEOUT, token) || '';
      const xy = statusLine.replace(/^\s*/, '').substring(0, 2);
      let resolved = false;
      if (strategy === 'ours') {
        if (xy[0] === 'D') resolved = gitSync(['rm', file], repoPath, GIT_TIMEOUT, token).success;
        else resolved = gitSync(['checkout', '--ours', '--', file], repoPath, GIT_TIMEOUT, token).success;
      } else {
        if (xy[1] === 'D') resolved = gitSync(['rm', file], repoPath, GIT_TIMEOUT, token).success;
        else resolved = gitSync(['checkout', '--theirs', '--', file], repoPath, GIT_TIMEOUT, token).success;
      }
      if (!resolved) {
        gitSync(['merge', '--abort'], repoPath, GIT_TIMEOUT, token);
        return { success: false, error: `Could not resolve file: ${file}` };
      }
    }
    gitSync(['add', '-A'], repoPath, GIT_TIMEOUT, token);
    const commit = gitSync(['commit', '-m', `auto-sync: resolve (${strategy})`], repoPath, GIT_TIMEOUT, token);
    if (!commit.success) {
      gitSync(['merge', '--abort'], repoPath, GIT_TIMEOUT, token);
      return { success: false, error: 'Could not commit resolution' };
    }
  }

  const pushResult = gitSync(['push', 'origin', branch], repoPath, GIT_LONG_TIMEOUT, token);
  if (!pushResult.success) {
    return { success: false, error: 'Push failed after conflict resolution', details: pushResult.stderr };
  }

  return { success: true, current: getBranch(repoPath, token), branch, strategy };
}

// --- Bestandssysteem browse (voor het aanmaken van repos op deze node) -----

function agentBrowseRoots() {
  const raw = process.env.BROWSE_ROOTS || '';
  const roots = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (roots.length) return roots;
  const home = os.homedir();
  try {
    if (home && fs.statSync(home).isDirectory()) return [home];
  } catch { /* val door naar / */ }
  return ['/'];
}

function isWithinAgentRoots(p, roots) {
  const resolved = path.resolve(p);
  return roots.some((r) => {
    const root = path.resolve(r);
    return resolved === root || resolved.startsWith(root + path.sep);
  });
}

async function executeBrowseTask(payload) {
  // payload.base = standaard map die de coordinator per node heeft ingesteld.
  const configuredRoots = agentBrowseRoots();
  const baseRoot = (payload && payload.base) ? path.resolve(String(payload.base)) : configuredRoots[0];
  const roots = (payload && payload.base) ? [baseRoot] : configuredRoots;
  const requested = (payload && payload.path) ? String(payload.path) : baseRoot;
  const base = path.resolve(requested.replace(/[\\/]+$/, '') || baseRoot);

  if (!isWithinAgentRoots(base, roots)) {
    return { success: true, path: base, parent: null, entries: [], roots, error: 'Toegang geweigerd: pad buiten toegestane mappen.' };
  }
  if (!fs.existsSync(base)) {
    return { success: true, path: base, parent: path.dirname(base), entries: [], roots, error: 'Path does not exist' };
  }
  if (!fs.statSync(base).isDirectory()) {
    return { success: true, path: base, parent: path.dirname(base), entries: [], roots, error: 'Not a directory' };
  }

  try {
    const all = fs.readdirSync(base, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const entry of all) {
      if (entry.name.startsWith('.') && entry.name !== '.git') continue;
      const full = path.join(base, entry.name);
      try {
        const s = fs.statSync(full);
        if (s.isDirectory()) {
          dirs.push({ name: entry.name, type: 'dir', path: full, hasGit: fs.existsSync(path.join(full, '.git')) });
        } else {
          files.push({ name: entry.name, type: 'file', path: full });
        }
      } catch { /* overslaan */ }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    const parent = base === path.parse(base).root ? null : path.dirname(base);
    const parentOk = parent && isWithinAgentRoots(parent, roots) ? parent : null;
    return { success: true, path: base, parent: parentOk, entries: [...dirs, ...files], roots };
  } catch (err) {
    return { success: true, path: base, parent: null, entries: [], roots, error: 'Kon map niet lezen.' };
  }
}

function sendMessage(type, payload, correlationId = null) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(createMessage(type, payload, correlationId)));
  }
}

function handleMessage(msg) {
  if (!validateAgentMessage(msg)) {
    log('warn', 'Invalid message received', msg);
    return;
  }

  const correlationId = msg.correlationId;

  switch (msg.type) {
    case MessageType.AGENT_INFO:
      if (msg.payload && msg.payload.nodeId) {
        nodeId = msg.payload.nodeId;
        log('info', 'Registered as node', { nodeId, name: msg.payload.name });
      }
      break;

    case MessageType.HEARTBEAT:
      sendMessage(MessageType.HEARTBEAT_ACK, { nodeId, timestamp: Date.now() }, correlationId);
      break;

    case MessageType.SYNC_REPO:
    case MessageType.CLONE_REPO:
    case MessageType.CREATE_REPO:
    case MessageType.FETCH_REPO:
    case MessageType.PULL_REPO:
    case MessageType.PUSH_REPO:
      handleTask(msg.type, msg.payload, correlationId);
      break;

    case MessageType.GET_STATUS:
      handleTask(MessageType.GET_STATUS, msg.payload, correlationId);
      break;

    case MessageType.GET_BRANCHES:
      handleTask(MessageType.GET_BRANCHES, msg.payload, correlationId);
      break;

    case MessageType.BROWSE_DIR:
      handleTask(MessageType.BROWSE_DIR, msg.payload, correlationId);
      break;

    case MessageType.SWITCH_BRANCH:
      handleTask(MessageType.SWITCH_BRANCH, msg.payload, correlationId);
      break;

    case MessageType.RESOLVE_CONFLICT:
      handleTask(MessageType.RESOLVE_CONFLICT, msg.payload, correlationId);
      break;

    case MessageType.CANCEL_TASK:
      if (currentTask && currentTask.correlationId === correlationId) {
        log('info', 'Task cancelled by coordinator', { correlationId });
        currentTask = null;
        if (taskTimeout) clearTimeout(taskTimeout);
      }
      break;

    case MessageType.SHUTDOWN:
      log('info', 'Shutdown command received');
      shutdown();
      break;

    default:
      log('warn', 'Unknown message type', { type: msg.type });
  }
}

async function handleTask(type, payload, correlationId) {
  // Read-only queries (status/branches/browse) mogen naast een draaiende sync
  // draaien, anders krijgt het dashboard steeds "Agent busy" terug.
  if (type === MessageType.GET_STATUS || type === MessageType.GET_BRANCHES || type === MessageType.BROWSE_DIR) {
    try {
      let result;
      if (type === MessageType.GET_STATUS) result = await executeStatusTask(payload);
      else if (type === MessageType.GET_BRANCHES) result = await executeBranchesTask(payload);
      else result = await executeBrowseTask(payload);
      sendMessage(MessageType.TASK_COMPLETED, { repoId: payload && payload.repoId, ...result }, correlationId);
    } catch (err) {
      sendMessage(MessageType.TASK_FAILED, { repoId: payload && payload.repoId, error: err.message }, correlationId);
    }
    return;
  }

  if (currentTask) {
    sendMessage(MessageType.TASK_FAILED, {
      repoId: payload.repoId,
      error: 'Agent busy with another task',
      correlationId,
    }, correlationId);
    return;
  }

  currentTask = { type, payload, correlationId, startTime: Date.now() };
  taskTimeout = setTimeout(() => {
    log('error', 'Task timeout', { correlationId, type });
    sendMessage(MessageType.TASK_FAILED, {
      repoId: payload.repoId,
      error: 'Task timeout',
      correlationId,
    }, correlationId);
    currentTask = null;
  }, TASK_TIMEOUT);

  sendMessage(MessageType.TASK_STARTED, { repoId: payload.repoId, type }, correlationId);

  try {
    let result;
    switch (type) {
      case MessageType.SYNC_REPO:
      case MessageType.FETCH_REPO:
      case MessageType.PULL_REPO:
      case MessageType.PUSH_REPO:
      case MessageType.CLONE_REPO:
        result = await executeSyncTask(payload);
        break;
      case MessageType.CREATE_REPO:
        result = await executeCreateTask(payload);
        break;
      case MessageType.GET_STATUS:
        result = await executeStatusTask(payload);
        break;
      case MessageType.GET_BRANCHES:
        result = await executeBranchesTask(payload);
        break;
      case MessageType.SWITCH_BRANCH:
        result = await executeSwitchBranchTask(payload);
        break;
      case MessageType.RESOLVE_CONFLICT:
        result = await executeResolveConflictTask(payload);
        break;
      default:
        result = { success: false, error: `Unknown task type: ${type}` };
    }

    if (taskTimeout) clearTimeout(taskTimeout);
    currentTask = null;

    if (result.success) {
      sendMessage(MessageType.TASK_COMPLETED, { repoId: payload.repoId, ...result }, correlationId);
    } else {
      sendMessage(MessageType.TASK_FAILED, { repoId: payload.repoId, ...result }, correlationId);
    }
  } catch (err) {
    if (taskTimeout) clearTimeout(taskTimeout);
    currentTask = null;
    log('error', 'Task execution error', { error: err.message, stack: err.stack });
    sendMessage(MessageType.TASK_FAILED, { repoId: payload.repoId, error: err.message }, correlationId);
  }
}

function connect() {
  const wsUrl = coordinatorUrl.replace(/^http/, 'ws') + '/agent';
  log('info', `Connecting to coordinator at ${wsUrl}`);

  ws = new WebSocket(wsUrl, {
    headers: {
      'X-Node-Key': nodeKey,
      'X-Protocol-Version': PROTOCOL_VERSION,
    },
    handshakeTimeout: 10000,
  });

  ws.on('open', () => {
    log('info', 'Connected to coordinator');
    reconnectAttempts = 0;
    sendMessage(MessageType.AGENT_INFO, {
      nodeId: null,
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      gitVersion: getGitVersion(),
      cwd: process.cwd(),
      nodeVersion: process.version,
    });
    startHeartbeat();
  });

  ws.on('message', (data) => {
    const msg = parseMessage(data);
    if (msg) handleMessage(msg);
  });

  ws.on('close', (code, reason) => {
    log('warn', `Disconnected from coordinator: ${code} ${reason}`);
    stopHeartbeat();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    log('error', 'WebSocket error', { error: err.message });
  });
}

function getGitVersion() {
  const result = spawnSync('git', ['--version'], { encoding: 'utf-8' });
  return result.success ? result.stdout.trim() : 'unknown';
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    sendMessage(MessageType.HEARTBEAT, { nodeId, timestamp: Date.now(), uptime: process.uptime() });
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log('error', 'Max reconnect attempts reached, giving up');
    process.exit(1);
  }
  const delay = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts) + Math.random() * 1000;
  reconnectAttempts++;
  log('info', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  setTimeout(connect, delay);
}

function shutdown() {
  log('info', 'Shutting down agent');
  stopHeartbeat();
  if (ws) {
    ws.close(1000, 'Agent shutdown');
    ws = null;
  }
  process.exit(0);
}

function validateConfig() {
  if (!coordinatorUrl) {
    console.error('COORDINATOR_URL environment variable is required');
    return false;
  }
  if (!nodeKey) {
    console.error('NODE_KEY environment variable is required');
    return false;
  }
  try {
    new URL(coordinatorUrl);
  } catch {
    console.error('COORDINATOR_URL must be a valid URL');
    return false;
  }
  return true;
}

function setupSignalHandlers() {
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    log('error', 'Uncaught exception', { error: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    log('error', 'Unhandled rejection', { reason: String(reason) });
  });
}

function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     MindGit Agent v1.0                   ║');
  console.log('║     Distributed Repository Sync Agent    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  if (!validateConfig()) {
    process.exit(1);
  }

  log('info', 'Starting agent', {
    coordinatorUrl,
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
  });

  setupSignalHandlers();
  connect();
}

main();
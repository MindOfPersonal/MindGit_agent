'use strict';

const PROTOCOL_VERSION = '1.0';

const MessageType = {
  // Coordinator -> Agent
  HEARTBEAT: 'heartbeat',
  SYNC_REPO: 'sync_repo',
  CLONE_REPO: 'clone_repo',
  CREATE_REPO: 'create_repo',
  FETCH_REPO: 'fetch_repo',
  PULL_REPO: 'pull_repo',
  PUSH_REPO: 'push_repo',
  GET_STATUS: 'get_status',
  GET_BRANCHES: 'get_branches',
  SWITCH_BRANCH: 'switch_branch',
  RESOLVE_CONFLICT: 'resolve_conflict',
  BROWSE_DIR: 'browse_dir',
  CANCEL_TASK: 'cancel_task',
  SHUTDOWN: 'shutdown',

  // Agent -> Coordinator
  HEARTBEAT_ACK: 'heartbeat_ack',
  TASK_STARTED: 'task_started',
  TASK_PROGRESS: 'task_progress',
  TASK_COMPLETED: 'task_completed',
  TASK_FAILED: 'task_failed',
  REPO_STATUS: 'repo_status',
  BRANCHES_LIST: 'branches_list',
  CONFLICT_DETECTED: 'conflict_detected',
  AGENT_INFO: 'agent_info',
  ERROR: 'error',
};

const TaskAction = {
  SYNC: 'sync',
  CLONE: 'clone',
  CREATE: 'create',
  FETCH: 'fetch',
  PULL: 'pull',
  PUSH: 'push',
  STATUS: 'status',
  BRANCHES: 'branches',
  SWITCH_BRANCH: 'switch_branch',
  RESOLVE_CONFLICT: 'resolve_conflict',
};

function createMessage(type, payload, correlationId = null) {
  return {
    v: PROTOCOL_VERSION,
    type,
    payload,
    correlationId,
    timestamp: Date.now(),
  };
}

function parseMessage(data) {
  try {
    const msg = JSON.parse(data);
    if (!msg.v || !msg.type) return null;
    return msg;
  } catch {
    return null;
  }
}

function createSyncRepoPayload(repo, token, options = {}) {
  return {
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    remote: repo.remote,
    token,
    githubUser: repo.github_user,
    commitMessage: options.commitMessage,
    action: options.action || TaskAction.SYNC,
  };
}

function createStatusPayload(repo, token) {
  return {
    repoId: repo.id,
    repoPath: repo.path,
    remote: repo.remote,
    token,
  };
}

function createBranchesPayload(repo, token) {
  return {
    repoId: repo.id,
    repoPath: repo.path,
    token,
  };
}

function createSwitchBranchPayload(repo, token, branch) {
  return {
    repoId: repo.id,
    repoPath: repo.path,
    token,
    branch,
  };
}

function createResolveConflictPayload(repo, token, strategy) {
  return {
    repoId: repo.id,
    repoPath: repo.path,
    token,
    strategy,
  };
}

function createBrowsePayload(nodePath) {
  return { path: nodePath || '' };
}

function validateAgentMessage(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.v !== PROTOCOL_VERSION) return false;
  if (!MessageType[msg.type.toUpperCase()] && !Object.values(MessageType).includes(msg.type)) return false;
  return true;
}

const HEARTBEAT_INTERVAL = 30000;
const TASK_TIMEOUT = 300000;

module.exports = {
  PROTOCOL_VERSION,
  MessageType,
  TaskAction,
  createMessage,
  parseMessage,
  createSyncRepoPayload,
  createStatusPayload,
  createBranchesPayload,
  createSwitchBranchPayload,
  createResolveConflictPayload,
  createBrowsePayload,
  validateAgentMessage,
  HEARTBEAT_INTERVAL,
  TASK_TIMEOUT,
};
# Agent Protocol

The agent and coordinator communicate over a single persistent **WebSocket** connection. The agent connects to `ws(s)://<COORDINATOR_URL>/agent`, authenticating with two handshake headers:

- `X-Node-Key` — the node key from the dashboard.
- `X-Protocol-Version` — the protocol version (`1.0`).

## Message envelope

Every message is a JSON object:

```json
{
  "v": "1.0",
  "type": "sync_repo",
  "payload": { "...": "..." },
  "correlationId": "abc-123",
  "timestamp": 1725000000000
}
```

| Field | Description |
|-------|-------------|
| `v` | Protocol version. Messages with a mismatched version are rejected. |
| `type` | Message type (see below). |
| `payload` | Task-specific data. |
| `correlationId` | Links responses to the original request. |
| `timestamp` | Unix timestamp in milliseconds. |

## Message types

### Coordinator → Agent

| Type | Purpose |
|------|---------|
| `heartbeat` | Ask the agent to confirm it is alive. |
| `sync_repo` | Full sync: fetch, pull and push a repository. |
| `clone_repo` | Clone a repository to the node. |
| `create_repo` | Create a new local repository and push it to GitHub. |
| `fetch_repo` | Fetch from origin. |
| `pull_repo` | Pull from origin. |
| `push_repo` | Commit local changes and push. |
| `get_status` | Repository status (changes, ahead/behind, branch). |
| `get_branches` | List local and remote branches. |
| `switch_branch` | Check out another branch. |
| `resolve_conflict` | Resolve (`ours`/`theirs`) or abort a merge conflict. |
| `browse_dir` | List a directory on the node's filesystem. |
| `cancel_task` | Cancel the running task with the given `correlationId`. |
| `shutdown` | Gracefully shut down the agent. |

### Agent → Coordinator

| Type | Purpose |
|------|---------|
| `heartbeat_ack` | Reply to a heartbeat. |
| `task_started` | The agent started executing a task. |
| `task_progress` | Progress update during a task, including a cumulative log. |
| `task_completed` | Task finished successfully, with the result payload. |
| `task_failed` | Task failed, with an error message. |
| `repo_status` | Repository status report. |
| `branches_list` | Branch list report. |
| `conflict_detected` | A merge conflict was detected during sync (includes the conflicting files). |
| `agent_info` | System information announced right after connecting. |
| `error` | Generic error. |

## Task execution flow

1. The coordinator sends a task (e.g. `sync_repo`) with a `correlationId`.
2. The agent replies with `task_started`.
3. During execution the agent sends `task_progress` messages (clone/fetch/pull/push/commit milestones).
4. The agent finishes with either `task_completed` (with the resulting repository status) or `task_failed`.
5. If a `pull` results in a merge conflict, the agent sends `conflict_detected` with the list of conflicting files and reports the task as failed. The coordinator can then issue a `resolve_conflict` task.

> Read-only queries (`get_status`, `get_branches`, `browse_dir`) can run alongside a busy sync task. All other tasks are refused with `Agent busy with another task` while another task is running.

## Heartbeats & timeouts

- The agent sends a heartbeat every **30 seconds** (`HEARTBEAT_INTERVAL`) with its node ID, timestamp and uptime.
- The coordinator can also ping with `heartbeat`; the agent responds with `heartbeat_ack`.
- A task that exceeds **300 seconds** (`TASK_TIMEOUT`) is aborted and reported as `task_failed` with `Task timeout`.

## Reconnection

If the connection drops, the agent reconnects automatically with exponential backoff (base delay 5s, doubling each attempt) up to **10 attempts**, after which it exits with code 1. The reconnect counter resets on a successful connection.

## Payload examples

### sync_repo

```json
{
  "v": "1.0",
  "type": "sync_repo",
  "correlationId": "job-42",
  "payload": {
    "repoId": "repo-1",
    "repoName": "my-project",
    "repoPath": "/home/user/mindgit/my-project",
    "remote": "myorg/my-project",
    "token": "github-personal-access-token",
    "githubUser": "myorg",
    "commitMessage": "auto-sync: custom message",
    "action": "sync",
    "syncDirection": "both"
  }
}
```

### resolve_conflict

```json
{
  "v": "1.0",
  "type": "resolve_conflict",
  "correlationId": "job-43",
  "payload": {
    "repoId": "repo-1",
    "repoPath": "/home/user/mindgit/my-project",
    "token": "github-personal-access-token",
    "strategy": "theirs"
  }
}
```

Valid strategies: `ours`, `theirs` (auto-resolve per file) or `abort` (cancel the merge).

### browse_dir

```json
{
  "v": "1.0",
  "type": "browse_dir",
  "correlationId": "job-44",
  "payload": { "path": "/home/user" }
}
```

The agent replies with directories and files, marking directories that contain a `.git` folder with `hasGit: true`.
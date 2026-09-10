# Troubleshooting

Common issues, how to diagnose them, and their fixes.

---

## The node does not appear in the dashboard

1. **Check the agent is running.**
   - Linux: `sudo systemctl status mindgit-agent`
   - macOS: `launchctl list | grep mindgit`
   - Windows: `net start | findstr MindGitAgent`
   - Foreground: look for the `Connected to coordinator` log line.

2. **Check the logs.**
   - Linux: `sudo journalctl -u mindgit-agent -f`
   - macOS: `tail -f ~/.local/share/mindgit-agent/agent.log`
   - Windows: check the console output of `start-agent.bat`.

3. **Verify the coordinator URL.** The agent connects to `ws(s)://<COORDINATOR_URL>/agent`. It must be reachable and correct. Test it:

   ```bash
   curl -I https://minddev.nl/agent
   ```

4. **Verify the node key.** The `NODE_KEY` must match the one generated in the dashboard (**Nodes → Add Node**). If wrong, the coordinator rejects the handshake.

---

## "COORDINATOR_URL environment variable is required" / "NODE_KEY ... is required"

The agent could not read the `.env` file or environment variables.

- Confirm `.env` exists next to `index.js` and contains both values (see [Configuration](CONFIGURATION.md)).
- Confirm the file permissions allow the agent user to read it (the installer sets `.env` to `640`/`600`).
- Real environment variables take precedence, but a *set-but-empty* variable also wins — check for empty values:

  ```bash
  env | grep -E 'COORDINATOR|NODE_KEY'
  ```

---

## The agent keeps reconnecting or exits

The agent reconnects with exponential backoff up to 10 attempts, then exits with code 1.

- **Coordinator unreachable** → check network/firewall, the URL scheme (`http`/`https`) and that the `/agent` endpoint is up.
- **Handshake rejected** → wrong node key or protocol version mismatch. Regenerate the node key in the dashboard.
- **Reconnect storm on the coordinator** → check the coordinator's logs for `X-Node-Key` failures.

---

## Task fails with "Agent busy with another task"

Only one mutating task can run at a time. `get_status`, `get_branches` and `browse_dir` run alongside. Wait for the running task to finish, or send a `cancel_task` with the task's `correlationId`.

---

## "Task timeout" after 5 minutes

A Git operation exceeded `TASK_TIMEOUT` (300 seconds).

- Large repositories or slow networks can exceed this. Check the `task_progress` logs to see which operation hung.
- If it is a single Git command that hangs, increase `GIT_TIMEOUT` / `GIT_LONG_TIMEOUT` in `.env` and restart the agent.

---

## Merge conflict detected

When a `pull` cannot fast-forward cleanly, the agent aborts the merge, sends `conflict_detected` with the conflicting files, and reports the task as failed.

**Resolution options:**

1. From the dashboard, send a `resolve_conflict` task with a strategy:
   - `ours` — keep the local version of conflicting files.
   - `theirs` — take the remote version.
   - `abort` — cancel the merge and leave the repo untouched.
2. Or resolve manually on the node: edit the files, `git add`, `git commit`, `git push`.

> Auto-resolution commits with the message `auto-sync: resolve (<strategy>)` and pushes to origin.

---

## "Push failed" / "Failed to push some refs"

- The remote branch has commits you do not have locally — the agent fetches and merges first during a full `sync`, so run a `sync_repo` before pushing.
- The GitHub token lacks push permissions — verify the token in the task payload can write to the repository.
- Non-fast-forward: if the pull step was skipped (`syncDirection: push`), a push may be rejected. Run a full sync instead.

---

## "Path exists but is not a git repository"

The target directory exists but has no `.git` folder.

- Remove the directory and retry (the agent will clone fresh), or
- Point the repository to a different `repoPath`.

---

## Browse shows "Access denied: path outside allowed directories"

The requested path is outside the agent's allowed roots.

- Default root: the current user's home directory (or `/`).
- Allow more roots by setting `BROWSE_ROOTS` as a comma-separated list of paths (environment variable only) and restarting the agent.

---

## Git / Node.js not found by the installer

The installers verify **Node.js 18+** and **Git** are present. If the installer complains:

- **Ubuntu/Debian:** `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`
- **RHEL/Fedora:** `curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo dnf install -y nodejs`
- **macOS:** `brew install node git`
- **Windows:** install Node.js from https://nodejs.org/ and Git from https://git-scm.com/ (both must be in `PATH`).

---

## Still stuck?

- Enable debug logging: set `LOG_LEVEL=debug` in `.env` and restart.
- Run the agent in the foreground (`node index.js`) to see raw logs.
- Check the coordinator / dashboard server logs for the matching node connection.
- Open an issue in this repository with the relevant log excerpts (remove any secrets first).
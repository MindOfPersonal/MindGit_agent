# Configuration

The agent reads its configuration from a `.env` file in the agent directory (there is no `dotenv` dependency — the file is parsed manually at startup). **Real environment variables always take precedence** over the `.env` file.

Copy the template and edit it:

```bash
cp .env.example .env
```

## Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COORDINATOR_URL` | **Yes** | — | URL of the MindGit coordinator. Must be a valid URL, e.g. `https://minddev.nl`. The agent connects to `/agent` on this host over WebSocket. |
| `NODE_KEY` | **Yes** | — | Node key obtained from the dashboard (**Nodes → Add Node**). Sent as the `X-Node-Key` header during the WebSocket handshake. |
| `GIT_TIMEOUT` | No | `15000` | Timeout in milliseconds for regular Git commands (status, rev-list, branch, ...). |
| `GIT_LONG_TIMEOUT` | No | `30000` | Timeout in milliseconds for long-running Git operations (clone, fetch, pull, push). |
| `LOG_LEVEL` | No | `info` | Log level: `debug`, `info`, `warn` or `error`. |

## Example

```env
# MindGit Agent Configuration
# Get these values from the MindGit dashboard (Nodes > Add Node)
COORDINATOR_URL=https://minddev.nl
NODE_KEY=your-node-key-from-dashboard

# Optional: Git timeouts (milliseconds)
GIT_TIMEOUT=15000
GIT_LONG_TIMEOUT=30000

# Optional: Log level (debug, info, warn, error)
LOG_LEVEL=info
```

## Additional environment variables

These are read from the environment only (not written by the installers):

| Variable | Description |
|----------|-------------|
| `BROWSE_ROOTS` | Comma-separated list of directories the agent may browse from the dashboard. Defaults to the current user's home directory, falling back to `/`. Paths outside the allowed roots are rejected with "Access denied". |

## Authentication & security

- The `NODE_KEY` authenticates the agent during the WebSocket handshake (`X-Node-Key` header). Keep it secret — it is stored in `.env`, which the installers set to read-only for the agent user.
- Git operations against GitHub use the token provided by the coordinator in each task payload, passed as an HTTP basic-auth header (`x-oauth-basic`).
- The agent only exposes repository operations on paths supplied by the coordinator and only allows filesystem browsing inside the configured `BROWSE_ROOTS`.

## Changing configuration

After editing `.env`, restart the agent:

- **Linux:** `sudo systemctl restart mindgit-agent`
- **macOS:** `launchctl stop com.mindgit.agent && launchctl start com.mindgit.agent`
- **Windows:** `net stop MindGitAgent && net start MindGitAgent`
- **Foreground:** stop `node index.js` and start it again.
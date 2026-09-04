# MindGit Agent

**MindGit Distributed Repository Sync Agent**

A lightweight Node.js agent that keeps local Git repositories in sync with GitHub, coordinated centrally through the [MindGit dashboard](https://minddev.nl). Install it on as many machines as you like — each one becomes a *node* that the coordinator can send sync, clone, pull, push, branch and conflict-resolution tasks to.

## Features

- **Distributed sync** — run the agent on multiple machines and let the coordinator orchestrate them centrally.
- **Automatic synchronization** — clone, fetch, pull and push repositories on demand.
- **Conflict handling** — detects merge conflicts and can auto-resolve them with a configurable strategy (`ours` / `theirs`) or abort cleanly.
- **Branch management** — list branches, switch branches, report ahead/behind counts.
- **Repository creation** — create a new local repository and push it to GitHub in one step.
- **Filesystem browsing** — browse the node's allowed directories from the dashboard (for choosing where to create repositories).
- **Resilient connection** — heartbeats, automatic reconnection with exponential backoff, and graceful shutdown on `SIGINT`/`SIGTERM`.
- **Runs as a service** — installers for Linux (systemd), macOS (launchd) and Windows (NSSM service or scheduled task).

## How it works

```
                        ┌──────────────────┐
                        │  MindGit server  │
                        │  (coordinator +  │
                        │   dashboard)     │
                        └────────┬─────────┘
                                 │ WebSocket (WSS)
              ┌──────────────────┼──────────────────┐
              │                  │                  │
       ┌──────┴──────┐   ┌──────┴──────┐   ┌──────┴──────┐
       │  Node A     │   │  Node B     │   │  Node C     │
       │ (this agent)│   │ (this agent)│   │ (this agent)│
       └─────────────┘   └─────────────┘   └─────────────┘
```

The agent opens a persistent WebSocket connection to the coordinator, authenticates with a **node key**, and announces itself with system information (platform, architecture, hostname, Git version). The coordinator then sends task messages, and the agent executes them locally against Git and streams progress back in real time.

Each message carries a `correlationId`, so the coordinator can match responses (started / progress / completed / failed) to the original request.

## Prerequisites

- **Node.js 18+** (with `npm`)
- **Git** installed and available in `PATH`
- A **node key** from the MindGit dashboard (**Nodes → Add Node**)
- The URL of your **MindGit coordinator** (e.g. `https://minddev.nl` or your own server)

## Installation

### Quick install

Install the agent on a machine and register it as a service:

| Platform | Command |
|----------|---------|
| Linux (systemd) | `curl -fsSL https://minddev.nl/agent/scripts/install-linux.sh \| bash -s -- --coordinator=https://minddev.nl --node-key=YOUR_KEY --system` |
| macOS (launchd) | `curl -fsSL https://minddev.nl/agent/scripts/install-linux.sh \| bash -s -- --coordinator=https://minddev.nl --node-key=YOUR_KEY` |
| Windows | Download `scripts/install-windows.bat` and run `install-windows.bat --coordinator=https://minddev.nl --node-key=YOUR_KEY` |

> Run `bash scripts/install-linux.sh --help` or `install-windows.bat --help` for all options.

### Manual install

```bash
git clone <this-repository>
cd MindGit_agent
npm ci --production
cp .env.example .env        # then fill in your values
npm start
```

## Configuration

All configuration is read from a `.env` file in the agent directory (real environment variables always take precedence). Copy `.env.example` to `.env` and fill in at least the first two values:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COORDINATOR_URL` | **Yes** | — | URL of the MindGit coordinator, e.g. `https://minddev.nl` |
| `NODE_KEY` | **Yes** | — | Node key obtained from the dashboard (**Nodes → Add Node**) |
| `GIT_TIMEOUT` | No | `15000` | Git command timeout in milliseconds |
| `GIT_LONG_TIMEOUT` | No | `30000` | Timeout for long operations (clone/pull/push) in milliseconds |
| `LOG_LEVEL` | No | `info` | Log level: `debug`, `info`, `warn` or `error` |

## Usage

The agent has no CLI subcommands — it connects to the coordinator and waits for tasks. Tasks can be triggered from the MindGit dashboard and include:

- **Sync repo** — fetch, pull and push to bring the local repo in line with GitHub.
- **Clone repo** — clone a GitHub repository to the node.
- **Create repo** — create a new local repository and push it to GitHub.
- **Fetch / Pull / Push** — individual Git operations.
- **Get status** — number of uncommitted changes, ahead/behind counts, current branch.
- **Get / switch branch** — list branches and switch the current branch.
- **Resolve conflict** — auto-resolve (`ours`/`theirs`) or abort a merge conflict.
- **Browse directory** — navigate the node's filesystem to pick repository locations.

The node key authenticates the agent and scopes which directories the coordinator may access. By default the agent may only browse the current user's home directory; set `BROWSE_ROOTS` (comma-separated paths) in the environment to allow more.

### Useful commands

```bash
# Run in the foreground (useful for testing)
npm start

# Check the service on Linux
sudo systemctl status mindgit-agent
sudo journalctl -u mindgit-agent -f

# Check the service on macOS
launchctl list | grep mindgit
tail -f ~/.local/share/mindgit-agent/agent.log

# Check the service on Windows
net start MindGitAgent
```

## Project structure

```
.
├── index.js                    # Agent entry point (connection, task execution)
├── lib/
│   └── agent-protocol.js       # Message protocol, types and payload builders
├── scripts/
│   ├── install-linux.sh        # Linux + macOS installer (systemd / launchd)
│   └── install-windows.bat     # Windows installer (NSSM / scheduled task)
├── Docs/                       # Tutorials and reference documentation
├── .env.example                # Configuration template
└── package.json
```

## Documentation

More detailed guides live in the [Docs](./Docs/) folder:

- [Installation tutorials](./Docs/INSTALLATION.md)
- [Configuration reference](./Docs/CONFIGURATION.md)
- [Agent protocol](./Docs/PROTOCOL.md)
- [Troubleshooting](./Docs/TROUBLESHOOTING.md)

## License

[MIT](./LICENSE)

---

*Maintained by [MindDevelopment](https://minddev.nl).*
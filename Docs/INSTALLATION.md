# Installation

This guide covers installing the MindGit Agent on all supported platforms. Before you start, make sure you have:

- **Node.js 18+** (with `npm`)
- **Git** installed and available in `PATH`
- A **node key** from the MindGit dashboard (**Nodes → Add Node**)
- The **coordinator URL** of your MindGit server (e.g. `https://minddev.nl`)

---

## Common options

Both installers accept the same set of options:

| Option | Description |
|--------|-------------|
| `--coordinator=URL` | Coordinator URL, e.g. `https://minddev.nl` |
| `--node-key=KEY` | Node key from the dashboard |
| `--system` | Install system-wide (requires root / Administrator) |
| `--user` | Install for the current user (default) |
| `--dir=PATH` | Custom install directory |
| `--help` | Show installer help |

---

## Linux (systemd)

### One-line install (system-wide)

```bash
curl -fsSL https://minddev.nl/agent/scripts/install-linux.sh | bash -s -- \
  --coordinator=https://minddev.nl \
  --node-key=YOUR_NODE_KEY \
  --system
```

This will:

1. Verify Node.js 18+, Git and npm are present.
2. Copy the agent to `/opt/mindgit-agent`.
3. Install npm dependencies.
4. Create a `.env` file with your values.
5. Create a dedicated `mindgit-agent` system user.
6. Install and enable a `mindgit-agent` systemd service.

### User install

```bash
curl -fsSL https://minddev.nl/agent/scripts/install-linux.sh | bash -s -- \
  --coordinator=https://minddev.nl \
  --node-key=YOUR_NODE_KEY
```

Installs to `~/.local/share/mindgit-agent` and runs under your own user (no service is created; start it manually with `node index.js`).

### Managing the service

```bash
# Start
sudo systemctl start mindgit-agent

# Status
sudo systemctl status mindgit-agent

# Logs (follow)
sudo journalctl -u mindgit-agent -f
```

### From source (alternative)

```bash
git clone <this-repository>
cd MindGit_agent
npm ci --production
cp .env.example .env      # fill in COORDINATOR_URL and NODE_KEY
npm start                 # foreground, useful for testing
```

---

## macOS (launchd)

The same `install-linux.sh` script detects macOS and installs a **launchd** service instead of systemd.

### One-line install

```bash
curl -fsSL https://minddev.nl/agent/scripts/install-linux.sh | bash -s -- \
  --coordinator=https://minddev.nl \
  --node-key=YOUR_NODE_KEY
```

Installs to `~/.local/share/mindgit-agent` and registers a `com.mindgit.agent` launchd agent that starts at login and keeps running.

### Managing the service

```bash
# Status
launchctl list | grep mindgit

# Logs
tail -f ~/.local/share/mindgit-agent/agent.log
tail -f ~/.local/share/mindgit-agent/agent.error.log

# Manual restart
launchctl stop com.mindgit.agent
launchctl start com.mindgit.agent
```

For a system-wide install (all users, boots at startup), pass `--system` and run with `sudo` — the service will be installed as a launch daemon in `/Library/LaunchDaemons`.

---

## Windows (NSSM service / scheduled task)

### One-line install

Download `scripts/install-windows.bat` from this repository and run:

```bat
install-windows.bat --coordinator=https://minddev.nl --node-key=YOUR_NODE_KEY
```

Or, if the full agent folder is present next to the script, just run it — it copies the files locally and prompts for missing values.

The installer will:

1. Verify Node.js 18+ and Git.
2. Copy the agent to `%LOCALAPPDATA%\MindGitAgent` (or `%PROGRAMFILES%\MindGitAgent` with `--system`).
3. Install npm dependencies.
4. Create a `.env` file.
5. Ask how to run the agent:
   - **1 — Windows Service** (via NSSM, recommended for servers). NSSM must be installed; otherwise it falls back to a scheduled task.
   - **2 — Scheduled Task at logon** (works everywhere).
   - **3 — Manual start only**.

### Managing the agent

```bat
REM Windows Service
net start MindGitAgent
net stop MindGitAgent

REM Manual start
%LOCALAPPDATA%\MindGitAgent\start-agent.bat
```

> **Note:** Windows 10 1803+ is required when the installer needs to download and extract the agent package (built-in `tar` and `curl`).

---

## Verifying your installation

After installation, check that the agent connects and registers:

1. Open the MindGit dashboard → **Nodes**.
2. Your new node should appear with its hostname, platform and Git version.
3. If it does not appear, see [Troubleshooting](TROUBLESHOOTING.md).

You can also run the agent in the foreground to watch the connection logs:

```bash
node index.js
# Expected output:
# [INFO] Starting agent {...}
# [INFO] Connecting to coordinator at wss://minddev.nl/agent
# [INFO] Connected to coordinator
# [INFO] Registered as node { nodeId: "...", name: "..." }
```
# NO-V15Today

Web interface for the [Luraph V15 Deobfuscator](https://github.com/caomod2077/Deobfuscator-Luraph-V15) by caomod2077.

> "Free plan, Pro, or Enterprise. The price tag doesn't change what the VM has to execute."

**NO-V15Today is not affiliated with Luraph, lura.ph, or the original engine author.**
It is an independent web frontend that calls the open-source CLI tool.

---

## What Is This

NO-V15Today is a web UI + Express server wrapper around [caomod2077's Luraph V15 Deobfuscator](https://github.com/caomod2077/Deobfuscator-Luraph-V15).

The underlying engine performs full devirtualization of Roblox Luau scripts protected by Luraph v15:

1. **AST Analysis & Hooking** — maps VM dispatcher loops and injects telemetry
2. **Sandboxed Simulation** — offline Roblox emulator, bypasses anti-tamper traps
3. **Live REPL Decryption** — decrypts 2,000–2,600 lazy-encrypted constants via IPC
4. **CFG Reconstruction** — restores control flow from flattened dispatch loops
5. **Register Web Analysis** — SSA-based variable naming from Roblox API usage
6. **Polish & Formatting** — idiomatic Luau output, verified by compile check

---

## Architecture & Privacy

```
Your .lua file
      ↓
Browser (NO-V15Today UI)
      ↓  HTTP POST to your own server
Your server / local machine  ← node server.js runs here
      ↓  child_process.spawn
Node.js deob.js  +  Python scripts  +  Luau binary
      ↓
Clean Luau source → back to browser
```

**Your scripts never leave your network.** The UI calls a backend server
you run yourself. No cloud uploads, no telemetry, no databases.

Temp files are written to `/tmp` and deleted after processing.

---

## Technical Limitations

| Feature | Vercel (static) | Full server (node server.js) |
|---|---|---|
| Web interface | ✓ | ✓ |
| Detection mode | ✓ (pure JS) | ✓ |
| Trace mode (`--no-devirt`) | ✗ | ✓ |
| Full devirt | ✗ | ✓ |
| Real-time SSE streaming | ✗ | ✓ |

**Why Vercel can't run the full engine:**
- Vercel's Lambda runtime does not include Python.
- Luau binaries (in `bin/`) are compiled for Linux x86_64 and cannot be
  spawned reliably from a serverless function.
- The full pipeline takes up to 2.5 minutes for large scripts, which
  exceeds Vercel's function timeout limits.

---

## Requirements

For the full deobfuscation pipeline:

- **Node.js** >= 18.0.0
- **Python** >= 3.10.0
- **git** (to clone the engine repo)
- Linux or macOS (the bundled Luau binaries in the engine are Linux x86_64)
- On Windows: use WSL (Windows Subsystem for Linux)

---

## Quick Start (Full Local Setup)

### 1. Clone the engine

```bash
git clone https://github.com/caomod2077/Deobfuscator-Luraph-V15.git
```

### 2. Clone / download this project

```bash
git clone https://your-repo/no-v15today.git
# or extract the downloaded zip
```

### 3. Install server dependencies

```bash
cd no-v15today
npm install
```

### 4. Configure the engine path

```bash
export DEOBF_PATH=/path/to/Deobfuscator-Luraph-V15
```

Or create a `.env` file (load it yourself before starting):
```
DEOBF_PATH=/path/to/Deobfuscator-Luraph-V15
PORT=3000
```

### 5. Start the server

```bash
node server.js
```

Expected output:
```
  NO-V15Today server

  URL:     http://localhost:3000
  Node:    v18.x.x ✓
  Engine:  /path/to/Deobfuscator-Luraph-V15
  Python:  Python 3.10.x ✓

  ✓  All systems ready. Open http://localhost:3000
```

### 6. Open the interface

Navigate to **http://localhost:3000** in your browser.

---

## Vercel Deployment (Frontend + Detection Only)

This deploys the UI and the detection-only API endpoint. Full deobfuscation
requires a separate backend (see [Pointing the UI at a remote backend](#remote-backend)).

### 1. Install Vercel CLI

```bash
npm install -g vercel
```

### 2. Build (static project, no build step)

```bash
npm run build
# Output: "Static project — no build step required."
```

### 3. Deploy

```bash
vercel --prod
```

The Vercel project serves:
- `index.html` — landing page (CDN)
- `deobf.html` — app page (CDN)
- `api/status.js` → `GET /api/status`
- `api/deobfuscate.js` → `POST /api/deobfuscate` (detection only)

### Configuring a remote backend after Vercel deployment {#remote-backend}

If you have a VPS running `node server.js`:

1. Open the NO-V15Today UI at your Vercel URL
2. Click the **⚙** (settings) button in the top-right corner
3. Enter your backend URL: `https://your-vps.example.com`
4. Click **Save & Reconnect**

The UI will use your backend for all deobfuscation requests.

---

## VPS Deployment (Full Engine)

On a Linux VPS (Ubuntu 22.04+ recommended):

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Python 3.10+
sudo apt-get install -y python3.10

# Install git
sudo apt-get install -y git

# Clone the engine
git clone https://github.com/caomod2077/Deobfuscator-Luraph-V15.git

# Clone/copy this project
git clone https://your-repo/no-v15today.git
cd no-v15today
npm install

# Start
export DEOBF_PATH=/root/Deobfuscator-Luraph-V15
export PORT=3000
node server.js

# Keep alive with PM2:
npm install -g pm2
DEOBF_PATH=/root/Deobfuscator-Luraph-V15 pm2 start server.js --name no-v15today
pm2 save
pm2 startup
```

For HTTPS behind Nginx, see standard Nginx reverse proxy configuration.

---

## API Reference

### `GET /api/status`

Reports environment capabilities.

```json
{
  "environment": "full",
  "capabilities": {
    "detection": true,
    "traceMode": true,
    "fullDevirt": true
  },
  "engine": {
    "path": "/path/to/engine",
    "found": true,
    "nodeVersion": "v18.12.0",
    "pythonVersion": "Python 3.10.6",
    "pythonOk": true
  }
}
```

### `POST /api/deobfuscate`

```json
{
  "source": "-- lua source code here",
  "filename": "script.lua",
  "options": {
    "noDevirt":     false,
    "noHooks":      false,
    "noFold":       false,
    "timeout":      90,
    "budget":       30,
    "maxRuns":      12,
    "devirtRounds": 200,
    "detect":       false,
    "debug":        false
  }
}
```

Response (success):
```json
{
  "success": true,
  "output": "-- clean Luau source",
  "detection": { "isLuraph": true, "patterns": { ... } },
  "stages": [
    { "key": "vmmap", "name": "AST Analysis & Hooking", "status": "done", "duration": 310 },
    ...
  ],
  "elapsed": 18420,
  "mode": "full"
}
```

Response (error):
```json
{
  "success": false,
  "error": "Human-readable error message",
  "hint": "Actionable instructions for fixing the problem",
  "detection": { ... },
  "elapsed": 120
}
```

### `GET /api/stream/:jobId` (SSE, local server only)

Stream real-time events for a job started with `?stream=1`.

Events:
- `detection` — Luraph pattern analysis result
- `stage` — `{ key, name, status, duration }`
- `log` — `{ type: 'stdout'|'stderr', line: '...' }`
- `complete` — final result with output
- `error` — engine error

---

## Configuration Options

All options correspond directly to the original CLI flags:

| Option | CLI flag | Default | Description |
|---|---|---|---|
| `noDevirt` | `--no-devirt` | false | Fast trace mode, skips bytecode lifting |
| `noHooks` | `--no-hooks` | false | Disable VM closure hooks |
| `noFold` | `--no-fold` | false | Disable loop folding in trace mode |
| `timeout` | `--timeout <sec>` | 90 | Hard timeout per Luau pass |
| `budget` | `--budget <sec>` | 30 | Soft execution budget |
| `maxRuns` | `--max-runs <n>` | 12 | Max anti-tamper re-runs |
| `devirtRounds` | `--devirt-rounds` | 200 | Max constant decryption rounds |
| `detect` | `--detect` | false | Detect only, no deobfuscation |
| `debug` | `--debug` | false | Keep intermediate files |

---

## Expected Processing Times

| Script Size | Functions | Mode | Time |
|---|---|---|---|
| Small / Micro | 1–20 | Full devirt | 1–5 seconds |
| Medium (hubs) | 50–200 | Full devirt | 15–35 seconds |
| Large (games) | 500–750+ | Full devirt | 1.5–2.5 minutes |
| Any size | Any | `--no-devirt` (trace) | ~2 seconds |

---

## Browser Support

| Browser | Interface | Notes |
|---|---|---|
| Chrome 90+ | ✓ Full | Recommended |
| Firefox 88+ | ✓ Full | |
| Safari 14+ | ✓ Full | |
| Edge 90+ | ✓ Full | |
| Android Chrome | ✓ Full | Backend needed for deobf |
| iOS Safari | ✓ Full | Backend needed for deobf |

The interface requires ES2020+ (modules, async/await, optional chaining).
No framework, no bundler, no build step.

---

## Development

```bash
# Install deps
npm install

# Start dev server (hot-reload not included; just restart on change)
node server.js

# Lint or test engine with a sample
node /path/to/deob.js sample.lua --detect
```

---

## Attribution & License

**NO-V15Today web interface** is MIT licensed.
Copyright (c) 2026 NO-V15Today contributors.

**Luraph V15 Deobfuscator** (the actual engine) is MIT licensed.
Copyright (c) 2026 caomod2077.
Repository: https://github.com/caomod2077/Deobfuscator-Luraph-V15

All credit for the deobfuscation algorithms, Luau runtime emulator,
SCCP symbolic execution, CFG reconstruction, and SSA variable naming
belongs to the original engine author.

This project makes no claim of authorship over the engine. It is purely
a web frontend that calls the engine's CLI.

**Luraph** (the obfuscator being reverse-engineered) is a commercial product
by lura.ph. This project is not affiliated with or endorsed by Luraph or lura.ph.

See `LICENSE` for the full MIT license text.

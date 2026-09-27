/**
 * NO-V15Today — Full local/VPS server
 *
 * This server:
 *  - Serves the static frontend files
 *  - Exposes POST /api/deobfuscate which runs the REAL engine
 *  - Exposes GET  /api/status which reports environment capabilities
 *  - Uses Server-Sent Events (SSE) for real-time stage updates
 *    (job mode: POST → jobId, then GET /api/stream/:jobId)
 *  - Falls back to synchronous mode when SSE is not requested
 *
 * Requirements:
 *  - Node.js >= 18.0.0
 *  - Python >= 3.10  (for full devirtualization)
 *  - Environment variable DEOBF_PATH pointing to the cloned engine repo:
 *      git clone https://github.com/caomod2077/Deobfuscator-Luraph-V15
 *
 * Usage:
 *  export DEOBF_PATH=/path/to/Deobfuscator-Luraph-V15
 *  node server.js
 *
 *  Or without DEOBF_PATH (detection mode only, engine calls will fail with clear error):
 *  node server.js
 */

'use strict';

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Engine path resolution ───────────────────────────────────────
function resolveEnginePath() {
  // 1. Explicit env var
  if (process.env.DEOBF_PATH) {
    const p = path.resolve(process.env.DEOBF_PATH);
    if (fs.existsSync(path.join(p, 'deob.js'))) return p;
    console.warn(`[warn] DEOBF_PATH="${p}" does not contain deob.js`);
  }
  // 2. Sibling directory named Deobfuscator-Luraph-V15
  const sibling = path.resolve(__dirname, '..', 'Deobfuscator-Luraph-V15');
  if (fs.existsSync(path.join(sibling, 'deob.js'))) return sibling;
  // 3. Current directory
  if (fs.existsSync(path.join(__dirname, 'deob.js'))) return __dirname;
  return null;
}

const ENGINE_PATH = resolveEnginePath();

// ─── Python check ─────────────────────────────────────────────────
async function checkPython() {
  try {
    const { stdout } = await execFileAsync('python3', ['--version'], { timeout: 3000 });
    const ver = stdout.trim() || '';
    const match = ver.match(/Python (\d+)\.(\d+)/);
    if (match) {
      const [, major, minor] = match.map(Number);
      return { available: true, version: ver, ok: major >= 3 && minor >= 10 };
    }
    return { available: true, version: ver, ok: false };
  } catch {
    try {
      const { stdout } = await execFileAsync('python', ['--version'], { timeout: 3000 });
      return { available: true, version: stdout.trim(), ok: false };
    } catch {
      return { available: false, version: null, ok: false };
    }
  }
}

// ─── Node version check ───────────────────────────────────────────
function checkNode() {
  const ver = process.version; // e.g. "v18.12.0"
  const major = parseInt(ver.slice(1), 10);
  return { version: ver, ok: major >= 18 };
}

// ─── Luraph detection (pure JS, always available) ─────────────────
function detectLuraph(source) {
  const patterns = {
    encstr:     /LPH_ENCSTR\s*\(/.test(source),
    encfunc:    /LPH_ENCFUNC\s*\(/.test(source),
    crash:      /LPH_CRASH\s*\(/.test(source),
    vmDispatch: (
      /while\s+true\s+do[\s\S]{0,400}?(?:local\s+\w+\s*=\s*\w+\s*\[\s*\w+\s*\])/.test(source) ||
      /LPH_JIT|LPH_NO_JIT|LPH_PROTECTED/.test(source)
    ),
  };
  const isLuraph = Object.values(patterns).some(Boolean);
  const lineCount = source.split('\n').length;
  let note = null;
  if (isLuraph) {
    if (lineCount > 5000)      note = `Large script (~${lineCount.toLocaleString()} lines). Full devirt may take 1–2.5 minutes.`;
    else if (lineCount > 500)  note = `Medium script (~${lineCount.toLocaleString()} lines). Full devirt typically takes 15–35 seconds.`;
    else                        note = `Small script (~${lineCount.toLocaleString()} lines). Full devirt typically takes 1–5 seconds.`;
  }
  return { isLuraph, version: isLuraph ? 'v15' : null, patterns, lineCount, note };
}

// ─── Build CLI args from options object ───────────────────────────
function buildArgs(inputFile, outputFile, options) {
  const args = [inputFile, '-o', outputFile];
  if (options.noDevirt)    args.push('--no-devirt');
  if (options.noHooks)     args.push('--no-hooks');
  if (options.noFold)      args.push('--no-fold');
  if (options.detect)      args.push('--detect');
  if (options.debug)       args.push('--debug');
  if (options.timeout  && options.timeout  !== 90)  args.push('--timeout',      String(options.timeout));
  if (options.budget   && options.budget   !== 30)  args.push('--budget',       String(options.budget));
  if (options.maxRuns  && options.maxRuns  !== 12)  args.push('--max-runs',     String(options.maxRuns));
  if (options.devirtRounds && options.devirtRounds !== 200) args.push('--devirt-rounds', String(options.devirtRounds));
  return args;
}

// ─── Stage detection from engine stdout ───────────────────────────
// The engine outputs progress to stdout. We parse known patterns to
// produce real stage updates.
const STAGE_PATTERNS = [
  { re: /vmmap|ast.*(analy|hook)|hook.*clos/i,        key: 'vmmap',   name: 'AST Analysis & Hooking' },
  { re: /sandbox|harness|simulation|envlog|luau.*exec/i, key: 'harness', name: 'Sandboxed Simulation' },
  { re: /devirt|repl|decrypt|constant|luasym/i,       key: 'devirt',  name: 'Symbolic Execution & REPL Decryption' },
  { re: /cfg|control.*flow|structure|loops|dominator/i, key: 'cfg',   name: 'CFG Reconstruction' },
  { re: /ssa|register|variable|scop|ren(am|um)/i,     key: 'ssa',     name: 'Register Web Analysis' },
  { re: /backend|polish|format|tidy|codegen|output/i, key: 'backend', name: 'Polish & Formatting' },
];

function parseStageFromLine(line) {
  for (const p of STAGE_PATTERNS) {
    if (p.re.test(line)) return { key: p.key, name: p.name };
  }
  return null;
}

// ─── In-memory job store (for SSE streaming) ─────────────────────
const jobs = new Map();
// jobs: Map<jobId, {
//   status: 'running' | 'done' | 'error',
//   stages: [...],
//   output: string | null,
//   error: string | null,
//   detection: object | null,
//   elapsed: number,
//   subscribers: Set<res>,
//   log: string[],
// }>

function createJob() {
  const id = uuidv4();
  jobs.set(id, {
    status: 'running',
    stages: [],
    output: null,
    error: null,
    detection: null,
    elapsed: 0,
    subscribers: new Set(),
    log: [],
  });
  // Clean up after 10 minutes
  setTimeout(() => jobs.delete(id), 600_000);
  return id;
}

function emitToJob(jobId, event, data) {
  const job = jobs.get(jobId);
  if (!job) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  job.log.push(payload);
  for (const sub of job.subscribers) {
    try { sub.write(payload); } catch { job.subscribers.delete(sub); }
  }
}

// ─── Core deobfuscation runner ────────────────────────────────────
async function runEngine(source, filename, options, onStage, onLog) {
  if (!ENGINE_PATH) {
    throw new Error(
      'Engine not found. Set DEOBF_PATH to the cloned Deobfuscator-Luraph-V15 directory.\n' +
      'Example: export DEOBF_PATH=/home/user/Deobfuscator-Luraph-V15'
    );
  }

  const deobScript = path.join(ENGINE_PATH, 'deob.js');
  if (!fs.existsSync(deobScript)) {
    throw new Error(`deob.js not found at ${deobScript}. Is DEOBF_PATH correct?`);
  }

  // Write input to temp file
  const inputId  = `nv15_in_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const outputId = `nv15_out_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const inputFile  = path.join(os.tmpdir(), `${inputId}.lua`);
  const outputFile = path.join(os.tmpdir(), `${outputId}.lua`);

  fs.writeFileSync(inputFile, source, 'utf8');

  const args = buildArgs(inputFile, outputFile, options);
  const t0 = Date.now();

  return new Promise((resolve, reject) => {
    const proc = spawn('node', [deobScript, ...args], {
      cwd: ENGINE_PATH,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout = [];
    const stderr = [];
    const activeStages = new Set();

    proc.stdout.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        stdout.push(line);
        if (onLog) onLog('stdout', line);

        const stage = parseStageFromLine(line);
        if (stage && !activeStages.has(stage.key)) {
          activeStages.add(stage.key);
          if (onStage) onStage(stage.key, stage.name, 'running');
        }
      }
    });

    proc.stderr.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        stderr.push(line);
        if (onLog) onLog('stderr', line);
      }
    });

    proc.on('close', code => {
      const elapsed = Date.now() - t0;

      // Clean up input file
      try { fs.unlinkSync(inputFile); } catch {}

      if (code !== 0) {
        try { fs.unlinkSync(outputFile); } catch {}
        const errMsg = stderr.join('\n') || stdout.join('\n') || `Process exited with code ${code}`;
        return reject(new Error(errMsg));
      }

      // Mark active stages as done
      for (const key of activeStages) {
        if (onStage) onStage(key, null, 'done');
      }

      // Read output
      let output = null;
      if (fs.existsSync(outputFile)) {
        output = fs.readFileSync(outputFile, 'utf8');
        try { if (!options.debug) fs.unlinkSync(outputFile); } catch {}
      } else {
        // Engine may have printed output to stdout directly (detect mode, etc.)
        output = stdout.join('\n');
      }

      resolve({ output, elapsed, stdout: stdout.join('\n'), stderr: stderr.join('\n') });
    });

    proc.on('error', err => {
      try { fs.unlinkSync(inputFile);  } catch {}
      try { fs.unlinkSync(outputFile); } catch {}
      reject(new Error(`Failed to start engine: ${err.message}`));
    });
  });
}

// ─── Middleware ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript');
  },
}));

// ─── GET /api/status ──────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const node   = checkNode();
  const python = await checkPython();

  const fullDevirt = !!(ENGINE_PATH && python.ok);
  const traceMode  = !!ENGINE_PATH;

  res.json({
    environment: 'full',
    capabilities: {
      detection:  true,
      traceMode,
      fullDevirt,
    },
    engine: {
      path:            ENGINE_PATH || null,
      found:           !!ENGINE_PATH,
      nodeVersion:     node.version,
      nodeOk:          node.ok,
      pythonVersion:   python.version,
      pythonOk:        python.ok,
      pythonAvailable: python.available,
    },
    notes: !ENGINE_PATH
      ? 'Engine not found. Set DEOBF_PATH environment variable.'
      : !python.ok
        ? `Python 3.10+ required for full devirt. Found: ${python.version || 'none'}.`
        : 'All systems ready.',
  });
});

// ─── POST /api/deobfuscate ────────────────────────────────────────
// Supports two modes:
//   sync:  Wait for result, return JSON directly (default).
//   async: Return { jobId }, client polls /api/stream/:jobId for SSE.
//
// Query param: ?stream=1 for async/SSE mode.
//
app.post('/api/deobfuscate', async (req, res) => {
  const body     = req.body || {};
  const source   = typeof body.source   === 'string' ? body.source   : '';
  const options  = typeof body.options  === 'object' ? body.options  : {};
  const filename = typeof body.filename === 'string' ? body.filename : 'script.lua';
  const useStream = req.query.stream === '1';

  if (!source.trim()) {
    return res.status(400).json({ success: false, error: 'No source provided.' });
  }

  const t0 = Date.now();
  const detection = detectLuraph(source);

  // Detection-only mode
  if (options.detect) {
    return res.json({
      success: true, output: null,
      detection,
      stages: [{ key: 'detect', name: 'Luraph Detection', status: 'done', duration: Date.now() - t0 }],
      elapsed: Date.now() - t0,
      mode: 'detect',
    });
  }

  // Engine not found
  if (!ENGINE_PATH) {
    return res.json({
      success: false,
      detection,
      stages: [],
      elapsed: Date.now() - t0,
      error: 'Engine not found.',
      hint:
        'Set the DEOBF_PATH environment variable to the cloned Deobfuscator-Luraph-V15 directory.\n' +
        'Example:\n  export DEOBF_PATH=/home/user/Deobfuscator-Luraph-V15\n  node server.js',
    });
  }

  // ── Async / SSE mode ──────────────────────────────────────────
  if (useStream) {
    const jobId = createJob();
    res.json({ jobId });

    const job = jobs.get(jobId);
    job.detection = detection;

    // Emit initial detection event
    emitToJob(jobId, 'detection', { detection });

    // Run engine asynchronously
    runEngine(
      source, filename, options,
      (key, name, status) => {
        const now = Date.now();
        const s = { key, name: name || key, status, duration: now - t0 };
        job.stages.push(s);
        emitToJob(jobId, 'stage', s);
      },
      (type, line) => {
        emitToJob(jobId, 'log', { type, line });
      }
    ).then(({ output, elapsed }) => {
      job.status  = 'done';
      job.output  = output;
      job.elapsed = elapsed;
      emitToJob(jobId, 'complete', {
        success: true, output, elapsed,
        detection: job.detection,
        stages: job.stages,
        mode: options.noDevirt ? 'trace' : 'full',
      });
      for (const sub of job.subscribers) { try { sub.end(); } catch {} }
    }).catch(err => {
      job.status = 'error';
      job.error  = err.message;
      emitToJob(jobId, 'error', { error: err.message });
      for (const sub of job.subscribers) { try { sub.end(); } catch {} }
    });

    return;
  }

  // ── Synchronous mode (default for Vercel compatibility) ───────
  try {
    const stagesCollected = [];

    const { output, elapsed } = await runEngine(
      source, filename, options,
      (key, name, status) => {
        const existing = stagesCollected.find(s => s.key === key);
        if (existing) { existing.status = status; }
        else { stagesCollected.push({ key, name: name || key, status, duration: Date.now() - t0 }); }
      },
      null
    );

    res.json({
      success: true,
      output,
      detection,
      stages: stagesCollected,
      elapsed,
      mode: options.noDevirt ? 'trace' : 'full',
    });

  } catch (err) {
    const isTimeout = /timeout/i.test(err.message);
    res.json({
      success: false,
      output: null,
      detection,
      stages: [],
      elapsed: Date.now() - t0,
      error: err.message,
      hint: isTimeout
        ? 'The script took too long. Try `--no-devirt` (trace mode) for a faster result, or increase the timeout.'
        : 'Check that the engine dependencies are installed (npm install in the engine directory) and Python 3.10+ is available.',
    });
  }
});

// ─── GET /api/stream/:jobId ───────────────────────────────────────
// Server-Sent Events for a running job.
app.get('/api/stream/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired.' });
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx passthrough

  // Replay existing events
  for (const payload of job.log) {
    res.write(payload);
  }

  if (job.status !== 'running') {
    res.end();
    return;
  }

  job.subscribers.add(res);
  req.on('close', () => {
    job.subscribers.delete(res);
  });
});

// ─── 404 fallback ─────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  // SPA fallback
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Not found');
  }
});

// ─── Start ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const node = checkNode();
  console.log(`\n  NO-V15Today server\n`);
  console.log(`  URL:     http://localhost:${PORT}`);
  console.log(`  Node:    ${node.version} ${node.ok ? '✓' : '✗ (requires >= 18)'}`);
  console.log(`  Engine:  ${ENGINE_PATH || '✗ not found — set DEOBF_PATH'}`);

  checkPython().then(py => {
    console.log(`  Python:  ${py.version || '✗ not found'} ${py.ok ? '✓' : '(requires >= 3.10 for full devirt)'}`);
    if (!ENGINE_PATH) {
      console.log(`\n  ⚠  To enable full deobfuscation:`);
      console.log(`     git clone https://github.com/caomod2077/Deobfuscator-Luraph-V15.git`);
      console.log(`     export DEOBF_PATH=$(pwd)/Deobfuscator-Luraph-V15`);
      console.log(`     node server.js`);
    } else if (!py.ok) {
      console.log(`\n  ⚠  Python 3.10+ required for full devirt (stages 3–6).`);
      console.log(`     Install: https://www.python.org/downloads/`);
    } else {
      console.log(`\n  ✓  All systems ready. Open http://localhost:${PORT}\n`);
    }
  });
});

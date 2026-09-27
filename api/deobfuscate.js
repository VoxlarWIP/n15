/**
 * POST /api/deobfuscate
 *
 * Vercel serverless function.
 *
 * CAPABILITIES ON VERCEL:
 *   ✓  Detection mode (pure JS, always works)
 *   ✗  Trace mode (needs Luau binary subprocess)
 *   ✗  Full devirt (needs Python 3.10+)
 *
 * FULL CAPABILITY requires running `node server.js` on a machine
 * with Node.js 18+ AND Python 3.10+ AND the engine repo cloned.
 *
 * This function will:
 *   1. Always run the JS detection analysis.
 *   2. If --detect flag: return detection result only.
 *   3. Otherwise: return a clear error explaining Python is required,
 *      plus the detection result.
 *
 * No fake output. No simulated deobfuscation. Real detection only.
 */

// ─── Luraph V15 detection (pure JS) ──────────────────────────────
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

  const isLuraph = patterns.encstr || patterns.encfunc || patterns.crash || patterns.vmDispatch;
  const version  = isLuraph ? 'v15' : null;

  // Estimate script complexity
  const lineCount = source.split('\n').length;
  let note = null;
  if (isLuraph) {
    if (lineCount > 5000) {
      note = `Large script (~${lineCount.toLocaleString()} lines). Full devirt may take 1–2.5 minutes on a local server.`;
    } else if (lineCount > 500) {
      note = `Medium script (~${lineCount.toLocaleString()} lines). Full devirt typically takes 15–35 seconds.`;
    } else {
      note = `Small script (~${lineCount.toLocaleString()} lines). Full devirt typically takes 1–5 seconds.`;
    }
  }

  return { isLuraph, version, patterns, lineCount, note };
}

// ─── Main handler ─────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { return res.status(204).end(); }
  if (req.method !== 'POST')    { return res.status(405).json({ error: 'Method not allowed' }); }

  // Body parsing (Vercel parses JSON automatically)
  const body = req.body || {};
  const source   = typeof body.source === 'string' ? body.source : '';
  const options  = typeof body.options === 'object' ? body.options : {};
  const filename = typeof body.filename === 'string' ? body.filename : 'script.lua';

  if (!source.trim()) {
    return res.status(400).json({ success: false, error: 'No source provided.' });
  }

  const t0 = Date.now();

  // Always run detection
  const detection = detectLuraph(source);
  const stages = [
    {
      key: 'detect',
      name: 'Luraph Detection (JS)',
      status: 'done',
      duration: Date.now() - t0,
    }
  ];

  // Detection-only mode
  if (options.detect) {
    return res.status(200).json({
      success: true,
      output:  null,
      detection,
      stages,
      elapsed: Date.now() - t0,
      mode: 'detect',
    });
  }

  // Full deobfuscation requested — not possible on Vercel
  const hint =
    `Full deobfuscation requires a self-hosted backend with Node.js 18+ and Python 3.10+.\n\n` +
    `How to set up the full server:\n` +
    `  1. Clone the engine: git clone https://github.com/caomod2077/Deobfuscator-Luraph-V15.git\n` +
    `  2. In this project: npm install\n` +
    `  3. Set the path: export DEOBF_PATH=/path/to/Deobfuscator-Luraph-V15\n` +
    `  4. Start the server: node server.js\n` +
    `  5. In the app ⚙ Settings: set backend URL to http://localhost:3000\n\n` +
    `Alternatively, deploy node server.js on a VPS and point the app at its URL.`;

  return res.status(200).json({
    success: false,
    output:  null,
    detection,
    stages,
    elapsed: Date.now() - t0,
    mode: 'vercel-detection-only',
    error: 'Full deobfuscation is not available on this Vercel deployment. Python 3.10+ is required.',
    hint,
  });
};

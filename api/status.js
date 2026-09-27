/**
 * GET /api/status
 *
 * Reports what this deployment can actually do.
 * On Vercel: detection-only (no Python runtime available).
 * On a full server (via server.js): all capabilities.
 */

// Check if we have a real engine available
function detectEnvironment() {
  const hasDeobfPath = !!(process.env.DEOBF_PATH);
  const isVercel     = !!(process.env.VERCEL || process.env.VERCEL_ENV);
  const hasPython    = false; // Vercel does not have Python in the Lambda env

  return {
    environment: isVercel ? 'vercel' : (hasDeobfPath ? 'full' : 'limited'),
    capabilities: {
      detection:  true,   // pure JS — always available
      traceMode:  false,  // needs Luau binary + Node.js subprocess
      fullDevirt: false,  // needs Python 3.10+
    },
    notes: isVercel
      ? 'Running on Vercel. Python 3.10+ is not available in the Lambda environment. ' +
        'Full deobfuscation requires a self-hosted backend running node server.js. ' +
        'Detection mode (pure JS pattern analysis) is always available.'
      : 'Engine path not configured. Set DEOBF_PATH env var and use node server.js for full capability.',
    enginePath: hasDeobfPath ? '[configured]' : null,
  };
}

module.exports = (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(detectEnvironment());
};

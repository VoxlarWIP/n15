/**
 * NO-V15Today — Main application logic for deobf.html
 */
import { CodeViewer } from './viewer.js';

// ─── State ───────────────────────────────────────────────────────
const state = {
  inputSource:   '',
  inputFilename: '',
  outputSource:  '',
  activeInputTab: 'upload',  // 'upload' | 'paste'
  isProcessing:  false,
  backendUrl:    localStorage.getItem('nv15_backend') || '',
  capabilities:  null,
  jobId:         null,
  stages:        [],
  elapsedStart:  0,
  elapsedTimer:  null,
};

// Stage definitions (must match engine pipeline order)
const STAGE_DEFS = [
  { key: 'vmmap',    name: 'AST Analysis & Hooking',              file: 'vmmap.js' },
  { key: 'harness',  name: 'Sandboxed Simulation',                file: 'harness.js' },
  { key: 'devirt',   name: 'Symbolic Execution & REPL Decryption', file: 'devirt.js + luasym.py' },
  { key: 'cfg',      name: 'CFG Reconstruction',                  file: 'structure.py' },
  { key: 'ssa',      name: 'Register Web Analysis',               file: 'variables.py' },
  { key: 'backend',  name: 'Polish & Formatting',                 file: 'backend.py' },
];

// ─── DOM refs ────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
  // nav
  navFilename:      $('nav-filename'),
  navStatusDot:     $('nav-status-dot'),
  navStatusText:    $('nav-status-text'),
  // capability banner
  capBanner:        $('cap-banner'),
  capBannerText:    $('cap-banner-text'),
  capBannerClose:   $('cap-banner-close'),
  // input tab buttons
  tabUpload:        $('tab-upload'),
  tabPaste:         $('tab-paste'),
  // upload area
  dropZone:         $('drop-zone'),
  fileInput:        $('file-input'),
  // file info
  fileInfo:         $('file-info'),
  fileInfoName:     $('file-info-name'),
  fileInfoSize:     $('file-info-size'),
  fileInfoLines:    $('file-info-lines'),
  btnClearInput:    $('btn-clear-input'),
  // paste area
  pasteArea:        $('paste-area'),
  pasteSection:     $('paste-section'),
  uploadSection:    $('upload-section'),
  // input viewer
  inScrollArea:     $('in-scroll-area'),
  inNums:           $('in-nums'),
  inLines:          $('in-lines'),
  inSearch:         $('in-search'),
  inMatches:        $('in-matches'),
  // config
  cfgNoDevirt:      $('cfg-no-devirt'),
  cfgNoHooks:       $('cfg-no-hooks'),
  cfgNoFold:        $('cfg-no-fold'),
  cfgTimeout:       $('cfg-timeout'),
  cfgBudget:        $('cfg-budget'),
  cfgMaxRuns:       $('cfg-max-runs'),
  cfgDevirtRounds:  $('cfg-devirt-rounds'),
  cfgDetect:        $('cfg-detect'),
  cfgDebug:         $('cfg-debug'),
  // run
  btnRun:           $('btn-run'),
  btnRunText:       $('btn-run-text'),
  btnRunSpinner:    $('btn-run-spinner'),
  elapsedDisplay:   $('elapsed-display'),
  // stages
  stagesList:       $('stages-list'),
  // output
  outputEmpty:      $('output-empty'),
  outputViewer:     $('output-viewer'),
  outScrollArea:    $('out-scroll-area'),
  outNums:          $('out-nums'),
  outLines:         $('out-lines'),
  outSearch:        $('out-search'),
  outMatches:       $('out-matches'),
  btnCopyOutput:    $('btn-copy-output'),
  btnDownload:      $('btn-download'),
  btnClearOutput:   $('btn-clear-output'),
  outputStats:      $('output-stats'),
  statLines:        $('stat-lines'),
  statSize:         $('stat-size'),
  statTime:         $('stat-time'),
  statMode:         $('stat-mode'),
  errorBlock:       $('error-block'),
  errorMsg:         $('error-msg'),
  errorHint:        $('error-hint'),
  detectResult:     $('detect-result'),
  // modal
  settingsBtn:      $('settings-btn'),
  modal:            $('backend-modal'),
  modalClose:       $('modal-close'),
  modalSave:        $('modal-save'),
  modalUrl:         $('modal-url'),
};

// ─── Viewers ─────────────────────────────────────────────────────
const inputViewer  = new CodeViewer(els.inScrollArea,  els.inNums,  els.inLines,  els.inSearch,  els.inMatches);
const outputViewer = new CodeViewer(els.outScrollArea, els.outNums, els.outLines, els.outSearch, els.outMatches);

// ─── Capability check ─────────────────────────────────────────────
async function checkCapabilities() {
  const base = state.backendUrl || '';
  try {
    const r = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('status endpoint returned ' + r.status);
    const data = await r.json();
    state.capabilities = data;

    if (data.environment === 'vercel' || !data.capabilities?.fullDevirt) {
      showBanner('warn', `Running in detection-only mode. Full deobfuscation requires a self-hosted backend. ` +
        `Configure one via the ⚙ button. See README for setup.`);
    } else {
      setNavStatus('ok', 'Engine connected');
    }
    return data;
  } catch {
    state.capabilities = null;
    showBanner('warn', 'Cannot reach backend. Detection mode available. Configure backend in ⚙ Settings.');
    setNavStatus('warn', 'No backend');
    return null;
  }
}

// ─── Banner ──────────────────────────────────────────────────────
function showBanner(type, msg) {
  els.capBanner.className = `cap-banner show ${type}-banner`;
  els.capBannerText.textContent = msg;
}
function hideBanner() {
  els.capBanner.classList.remove('show');
}

// ─── Nav status ───────────────────────────────────────────────────
function setNavStatus(state_, text) {
  els.navStatusDot.className = `status-dot ${state_}`;
  els.navStatusText.textContent = text;
}

// ─── Tab switching ────────────────────────────────────────────────
function setTab(tab) {
  state.activeInputTab = tab;
  els.tabUpload.classList.toggle('active', tab === 'upload');
  els.tabPaste.classList.toggle('active',  tab === 'paste');
  els.uploadSection.style.display = tab === 'upload' ? '' : 'none';
  els.pasteSection.style.display  = tab === 'paste'  ? '' : 'none';
}

// ─── File loading ─────────────────────────────────────────────────
function loadText(text, filename) {
  state.inputSource   = text;
  state.inputFilename = filename || 'script.lua';
  els.navFilename.textContent = state.inputFilename;

  inputViewer.setSource(text);

  // Show file info bar
  els.fileInfoName.textContent  = state.inputFilename;
  els.fileInfoSize.textContent  = formatBytes(new TextEncoder().encode(text).length);
  els.fileInfoLines.textContent = `${text.split('\n').length.toLocaleString()} lines`;
  els.fileInfo.style.display = 'flex';

  // Switch to upload tab / hide drop zone if file loaded
  setTab('upload');
}

function clearInput() {
  state.inputSource   = '';
  state.inputFilename = '';
  els.navFilename.textContent = '';
  els.fileInfo.style.display = 'none';
  els.fileInput.value = '';
  els.pasteArea.value = '';
  inputViewer.clear();
}

// ─── Drag & drop ──────────────────────────────────────────────────
function setupDragDrop() {
  const zone = els.dropZone;

  zone.addEventListener('dragenter', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', e => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) readFile(file);
  });
  els.fileInput.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) readFile(file);
  });
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = ev => loadText(ev.target.result, file.name);
  reader.readAsText(file);
}

// ─── Paste tab ────────────────────────────────────────────────────
els.pasteArea.addEventListener('input', () => {
  const text = els.pasteArea.value;
  if (text) loadText(text, 'pasted-script.lua');
  else clearInput();
});

// ─── Get effective source ─────────────────────────────────────────
function getSource() {
  if (state.activeInputTab === 'paste') return els.pasteArea.value;
  return state.inputSource;
}

// ─── Deobfuscate ──────────────────────────────────────────────────
async function runDeobf() {
  const source = getSource();
  if (!source.trim()) {
    alert('Please upload or paste a Lua script first.');
    return;
  }
  if (state.isProcessing) return;

  state.isProcessing = true;
  setProcessingUI(true);
  clearOutput();
  resetStages();
  startElapsed();

  const options = getOptions();
  const base = state.backendUrl || '';
  const payload = {
    source,
    filename: state.inputFilename || 'script.lua',
    options
  };

  try {
    const r = await fetch(`${base}/api/deobfuscate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout((options.timeout + 30) * 1000),
    });

    const data = await r.json();

    if (!r.ok) {
      showError(data.error || `Server returned ${r.status}`, data.hint);
      return;
    }

    // Update stages from response
    if (data.stages) {
      data.stages.forEach(s => markStage(s.key || s.name, s.status, s.duration));
    }

    // Detection result
    if (data.detection) {
      showDetectionResult(data.detection);
    }

    if (!data.success) {
      showError(data.error || 'Unknown error', data.hint);
      return;
    }

    if (data.output) {
      showOutput(data.output, data.elapsed, data.mode);
    }

  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      showError(
        'Request timed out.',
        `The engine is still running. Try increasing the timeout or switch to trace mode (--no-devirt) for large scripts.`
      );
    } else {
      showError(
        err.message || 'Network error',
        `Is the backend server running? Start it with: node server.js\n` +
        `Configure the backend URL in ⚙ Settings.`
      );
    }
  } finally {
    state.isProcessing = false;
    setProcessingUI(false);
    stopElapsed();
    setNavStatus('ok', 'Ready');
  }
}

// ─── Configuration ────────────────────────────────────────────────
function getOptions() {
  return {
    noDevirt:     els.cfgNoDevirt.checked,
    noHooks:      els.cfgNoHooks.checked,
    noFold:       els.cfgNoFold.checked,
    timeout:      parseInt(els.cfgTimeout.value, 10) || 90,
    budget:       parseInt(els.cfgBudget.value, 10) || 30,
    maxRuns:      parseInt(els.cfgMaxRuns.value, 10) || 12,
    devirtRounds: parseInt(els.cfgDevirtRounds.value, 10) || 200,
    detect:       els.cfgDetect.checked,
    debug:        els.cfgDebug.checked,
  };
}

// ─── Stages UI ────────────────────────────────────────────────────
function resetStages() {
  state.stages = STAGE_DEFS.map(d => ({ ...d, status: 'pending', duration: null }));
  renderStages();
}

function markStage(keyOrName, status, duration) {
  const s = state.stages.find(s => s.key === keyOrName || s.name === keyOrName);
  if (s) { s.status = status; if (duration != null) s.duration = duration; }
  renderStages();
}

function renderStages() {
  els.stagesList.innerHTML = '';
  state.stages.forEach(s => {
    const item = document.createElement('div');
    item.className = `stage-item ${s.status}`;
    const icons = { pending: 'circle', running: 'loader', done: 'check-circle-2', error: 'x-circle' };
    item.innerHTML = `
      <svg data-lucide="${icons[s.status] || 'circle'}" class="stage-item-icon icon-sm"></svg>
      <span class="stage-item-name">${escHtml(s.name)}</span>
      ${s.duration != null ? `<span class="stage-item-dur">${(s.duration/1000).toFixed(2)}s</span>` : ''}
    `;
    els.stagesList.appendChild(item);
  });
  if (window.lucide) lucide.createIcons({ nodes: [els.stagesList] });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Output display ───────────────────────────────────────────────
function showOutput(text, elapsed, mode) {
  state.outputSource = text;
  els.outputEmpty.style.display  = 'none';
  els.outputViewer.style.display = 'flex';

  outputViewer.setSource(text);

  const lines = text.split('\n').length;
  const bytes = new TextEncoder().encode(text).length;
  els.statLines.textContent = lines.toLocaleString();
  els.statSize.textContent  = formatBytes(bytes);
  els.statTime.textContent  = elapsed != null ? `${(elapsed/1000).toFixed(2)}s` : '—';
  els.statMode.textContent  = mode || 'full';
  els.outputStats.style.display = 'flex';
}

function showError(msg, hint) {
  els.errorBlock.style.display = 'block';
  els.errorMsg.textContent = msg;
  els.errorHint.innerHTML  = hint ? hint.replace(/`([^`]+)`/g, '<code>$1</code>') : '';
}

function showDetectionResult(det) {
  els.detectResult.style.display = 'block';
  els.detectResult.className = `detect-result ${det.isLuraph ? 'is-luraph' : 'not-luraph'}`;
  const icon   = det.isLuraph ? '🔍 Luraph V15 detected' : '✗ Not detected as Luraph V15';
  const color  = det.isLuraph ? 'var(--ok)' : 'var(--text-secondary)';

  let patternsHtml = '';
  const patterns = det.patterns || {};
  const patternLabels = {
    encstr: 'LPH_ENCSTR (encrypted strings)',
    encfunc: 'LPH_ENCFUNC (encrypted functions)',
    crash: 'LPH_CRASH (anti-tamper traps)',
    vmDispatch: 'VM dispatcher loop'
  };
  for (const [key, label] of Object.entries(patternLabels)) {
    const found = !!patterns[key];
    patternsHtml += `<div class="detect-pattern ${found ? 'found' : 'missing'}">
      <svg data-lucide="${found ? 'check' : 'x'}" width="12" height="12"></svg>
      ${label}
    </div>`;
  }

  els.detectResult.innerHTML = `
    <div class="detect-title" style="color:${color}">${icon}</div>
    <div class="detect-patterns">${patternsHtml}</div>
    ${det.note ? `<p style="font-size:.76rem;color:var(--text-muted);margin-top:8px">${escHtml(det.note)}</p>` : ''}
  `;
  if (window.lucide) lucide.createIcons({ nodes: [els.detectResult] });
}

function clearOutput() {
  state.outputSource = '';
  els.outputEmpty.style.display  = 'block';
  els.outputViewer.style.display = 'none';
  els.outputStats.style.display  = 'none';
  els.errorBlock.style.display   = 'none';
  els.detectResult.style.display = 'none';
  outputViewer.clear();
}

// ─── Processing UI state ──────────────────────────────────────────
function setProcessingUI(busy) {
  els.btnRun.disabled = busy;
  els.btnRunText.textContent = busy ? 'Processing…' : 'Deobfuscate';
  els.btnRunSpinner.style.display = busy ? 'block' : 'none';
  setNavStatus(busy ? 'busy' : 'ok', busy ? 'Processing…' : 'Ready');
}

// ─── Elapsed timer ────────────────────────────────────────────────
function startElapsed() {
  state.elapsedStart = Date.now();
  stopElapsed();
  state.elapsedTimer = setInterval(() => {
    const ms = Date.now() - state.elapsedStart;
    els.elapsedDisplay.textContent = (ms / 1000).toFixed(1) + 's';
  }, 100);
}
function stopElapsed() {
  if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
}

// ─── Copy / Download ──────────────────────────────────────────────
async function copyOutput() {
  if (!state.outputSource) return;
  try {
    await navigator.clipboard.writeText(state.outputSource);
    const btn = els.btnCopyOutput;
    const prev = btn.innerHTML;
    btn.innerHTML = btn.innerHTML.replace(/Copy/,'Copied!');
    setTimeout(() => { btn.innerHTML = prev; if(window.lucide) lucide.createIcons({nodes:[btn]}); }, 2000);
  } catch { /* fallback omitted for brevity */ }
}

function downloadOutput() {
  if (!state.outputSource) return;
  const name = state.inputFilename.replace(/\.lua$/i, '') + '_deobf.lua';
  const blob = new Blob([state.outputSource], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Settings modal ───────────────────────────────────────────────
function openSettings() {
  els.modalUrl.value = state.backendUrl;
  els.modal.classList.remove('hidden');
}
function closeSettings() {
  els.modal.classList.add('hidden');
}
function saveSettings() {
  state.backendUrl = els.modalUrl.value.trim().replace(/\/$/, '');
  localStorage.setItem('nv15_backend', state.backendUrl);
  closeSettings();
  checkCapabilities();
}

// ─── Helpers ──────────────────────────────────────────────────────
function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/1024/1024).toFixed(2) + ' MB';
}

// ─── Event wiring ─────────────────────────────────────────────────
function wireEvents() {
  // Tabs
  els.tabUpload.addEventListener('click', () => setTab('upload'));
  els.tabPaste.addEventListener('click',  () => setTab('paste'));

  // Clear
  els.btnClearInput.addEventListener('click', clearInput);
  els.btnClearOutput.addEventListener('click', clearOutput);

  // Run
  els.btnRun.addEventListener('click', runDeobf);

  // Output actions
  els.btnCopyOutput.addEventListener('click', copyOutput);
  els.btnDownload.addEventListener('click',   downloadOutput);

  // Settings
  els.settingsBtn.addEventListener('click', openSettings);
  els.modalClose.addEventListener('click',  closeSettings);
  els.modalSave.addEventListener('click',   saveSettings);
  els.modal.addEventListener('click', e => { if (e.target === els.modal) closeSettings(); });

  // Banner close
  els.capBannerClose.addEventListener('click', hideBanner);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSettings();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !state.isProcessing) runDeobf();
  });

  // Drop zone
  setupDragDrop();
}

// ─── Init ─────────────────────────────────────────────────────────
wireEvents();
setTab('upload');
resetStages();
checkCapabilities();

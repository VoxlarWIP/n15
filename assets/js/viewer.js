/**
 * CodeViewer — virtual-scroll code display with Lua syntax highlighting and search.
 * Renders only visible lines for performance with large files.
 * All user content is escaped before insertion — no XSS risk.
 */

const LINE_H = 21; // px — must match CSS .code-line height
const OVERSCAN = 30; // extra lines rendered above/below viewport

// ─── HTML entity escape (must happen BEFORE any highlighting) ────
function escHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Lua syntax highlighter (operates on already-escaped HTML) ───
const LUA_KEYWORDS = new Set([
  'and','break','do','else','elseif','end','false','for','function',
  'if','in','local','nil','not','or','repeat','return','then','true',
  'until','while'
]);
const LUA_BUILTINS = new Set([
  'print','type','tostring','tonumber','pairs','ipairs','next',
  'select','unpack','table','string','math','coroutine','io','os',
  'require','error','pcall','xpcall','assert','rawget','rawset',
  'rawequal','rawlen','setmetatable','getmetatable','load','loadstring',
  'dofile','loadfile','collectgarbage','game','workspace','script',
  'Enum','Vector3','CFrame','Color3','UDim2','UDim','TweenInfo',
  'Instance','Players','ReplicatedStorage','ServerScriptService',
  'RunService','TweenService','UserInputService','HttpService',
  'SoundService','Lighting','PathfindingService','Teams'
]);

function highlightLua(escapedLine) {
  // We tokenize left-to-right, building the output as we go.
  let result = '';
  let i = 0;
  const s = escapedLine;
  const len = s.length;

  while (i < len) {
    // Long string / long comment: [[ ... ]]
    if (s[i] === '-' && s[i+1] === '-' && s[i+2] === '[' && s[i+3] === '[') {
      const end = s.indexOf(']]', i + 4);
      const chunk = end === -1 ? s.slice(i) : s.slice(i, end + 2);
      result += `<span class="syn-comment">${chunk}</span>`;
      i += chunk.length;
      continue;
    }
    // Single-line comment: -- ...
    if (s[i] === '-' && s[i+1] === '-') {
      result += `<span class="syn-comment">${s.slice(i)}</span>`;
      break;
    }
    // String: " ... " or ' ... '
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      let j = i + 1;
      while (j < len) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === q) { j++; break; }
        j++;
      }
      result += `<span class="syn-string">${s.slice(i, j)}</span>`;
      i = j;
      continue;
    }
    // Number: hex or decimal
    if (/[0-9]/.test(s[i]) || (s[i] === '.' && /[0-9]/.test(s[i+1] || ''))) {
      let j = i;
      if (s[i] === '0' && (s[i+1] === 'x' || s[i+1] === 'X')) {
        j += 2;
        while (j < len && /[0-9a-fA-F_]/.test(s[j])) j++;
      } else {
        while (j < len && /[0-9._eE+\-]/.test(s[j])) j++;
      }
      result += `<span class="syn-number">${s.slice(i, j)}</span>`;
      i = j;
      continue;
    }
    // Identifier or keyword
    if (/[a-zA-Z_]/.test(s[i])) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_]/.test(s[j])) j++;
      const word = s.slice(i, j);
      if (LUA_KEYWORDS.has(word)) {
        result += `<span class="syn-keyword">${word}</span>`;
      } else if (LUA_BUILTINS.has(word)) {
        result += `<span class="syn-builtin">${word}</span>`;
      } else {
        result += word;
      }
      i = j;
      continue;
    }
    // Operators & punctuation
    result += s[i];
    i++;
  }
  return result;
}

// ─── CodeViewer class ────────────────────────────────────────────
export class CodeViewer {
  /**
   * @param {HTMLElement} scrollEl   — the scrollable container
   * @param {HTMLElement} numsEl     — the line-number gutter
   * @param {HTMLElement} linesEl    — the code-lines container
   * @param {HTMLElement} searchInput — search <input>
   * @param {HTMLElement} matchLabel  — match count label element
   */
  constructor(scrollEl, numsEl, linesEl, searchInput, matchLabel) {
    this._scroll = scrollEl;
    this._nums   = numsEl;
    this._lines  = linesEl;
    this._search = searchInput;
    this._matchLbl = matchLabel;

    this._rawLines    = []; // array of raw strings
    this._highlighted = []; // array of HTML strings
    this._matchLines  = new Set();
    this._query       = '';
    this._rendered    = { start: -1, end: -1 };

    this._scroll.addEventListener('scroll', () => this._onScroll(), { passive: true });
    if (this._search) {
      this._search.addEventListener('input', () => this._onSearch());
    }
  }

  /** Load new content into the viewer */
  setSource(text) {
    this._rawLines    = text === '' ? [] : text.split('\n');
    this._highlighted = this._rawLines.map(l => highlightLua(escHtml(l)));
    this._matchLines  = new Set();
    this._query       = '';
    if (this._search) this._search.value = '';
    if (this._matchLbl) this._matchLbl.textContent = '';
    this._rendered    = { start: -1, end: -1 };
    this._syncHeight();
    this._render();
  }

  /** Clear the viewer */
  clear() { this.setSource(''); }

  /** Scroll to a specific 1-based line number */
  scrollToLine(lineNo) {
    const top = (lineNo - 1) * LINE_H;
    this._scroll.scrollTop = Math.max(0, top - this._scroll.clientHeight / 2);
  }

  /** Return the raw source text */
  getSource() { return this._rawLines.join('\n'); }

  lineCount() { return this._rawLines.length; }

  // ── private ───────────────────────────────────────────────────

  _syncHeight() {
    const total = this._rawLines.length * LINE_H + 16; // 8px padding top+bottom
    this._lines.style.height  = total + 'px';
    this._nums.style.height   = total + 'px';
    // widen gutter for large files
    const digits = String(this._rawLines.length).length;
    const w = Math.max(52, digits * 9 + 20);
    this._nums.style.width    = w + 'px';
    this._nums.style.minWidth = w + 'px';
  }

  _visibleRange() {
    const scrollTop    = this._scroll.scrollTop;
    const clientHeight = this._scroll.clientHeight;
    const start = Math.max(0, Math.floor(scrollTop / LINE_H) - OVERSCAN);
    const end   = Math.min(
      this._rawLines.length - 1,
      Math.ceil((scrollTop + clientHeight) / LINE_H) + OVERSCAN
    );
    return { start, end };
  }

  _render() {
    const { start, end } = this._visibleRange();
    if (start === this._rendered.start && end === this._rendered.end) return;
    this._rendered = { start, end };

    const numFrag  = document.createDocumentFragment();
    const lineFrag = document.createDocumentFragment();

    // Top spacer
    const topH = start * LINE_H;
    const topSpacer = document.createElement('div');
    topSpacer.style.height = topH + 'px';
    numFrag.appendChild(topSpacer.cloneNode());
    lineFrag.appendChild(topSpacer);

    for (let i = start; i <= end; i++) {
      // Line number
      const numEl = document.createElement('span');
      numEl.className = 'line-num' + (this._matchLines.has(i) ? ' highlight' : '');
      numEl.textContent = i + 1;
      numFrag.appendChild(numEl);

      // Code line
      const lineEl = document.createElement('span');
      lineEl.className = 'code-line' + (this._matchLines.has(i) ? ' search-match' : '');
      lineEl.innerHTML = this._highlighted[i] || '\u200B'; // zero-width space for empty lines
      lineFrag.appendChild(lineEl);
    }

    // Bottom spacer
    const remaining = Math.max(0, this._rawLines.length - 1 - end);
    const botH = remaining * LINE_H;
    if (botH > 0) {
      const botSpacer = document.createElement('div');
      botSpacer.style.height = botH + 'px';
      numFrag.appendChild(botSpacer.cloneNode());
      lineFrag.appendChild(botSpacer);
    }

    // Swap in
    this._nums.innerHTML  = '';
    this._lines.innerHTML = '';
    this._nums.appendChild(numFrag);
    this._lines.appendChild(lineFrag);
  }

  _onScroll() {
    this._render();
  }

  _onSearch() {
    const q = this._search.value.trim().toLowerCase();
    this._query = q;
    this._matchLines.clear();

    if (q.length >= 1) {
      for (let i = 0; i < this._rawLines.length; i++) {
        if (this._rawLines[i].toLowerCase().includes(q)) {
          this._matchLines.add(i);
        }
      }
    }

    if (this._matchLbl) {
      this._matchLbl.textContent = q
        ? `${this._matchLines.size} match${this._matchLines.size === 1 ? '' : 'es'}`
        : '';
    }

    // Re-highlight with match markup
    this._highlighted = this._rawLines.map((l, i) => {
      const esc = escHtml(l);
      const highlighted = highlightLua(esc);
      return highlighted;
    });

    this._rendered = { start: -1, end: -1 }; // force full re-render
    this._render();

    // Scroll to first match
    if (this._matchLines.size > 0) {
      this.scrollToLine(Math.min(...this._matchLines) + 1);
    }
  }
}

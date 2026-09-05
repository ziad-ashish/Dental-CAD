/**
 * logger.js — Centralised logging + error boundaries for DentalCAD
 *
 * Features:
 *  - Log levels: DEBUG / INFO / WARN / ERROR
 *  - Keeps a circular in-memory buffer (last 500 entries)
 *  - Shows a non-blocking toast notification for ERRORs
 *  - Catches unhandled promise rejections + global errors
 *  - downloadLogs() exports the buffer as a .log file
 *  - window.DentalCADLogger exposed for DevTools inspection
 */

const Logger = (() => {

  const LEVELS  = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
  const LABELS  = ['DEBUG', 'INFO ', 'WARN ', 'ERROR'];
  const COLORS  = ['#666', '#9cdcfe', '#e8c065', '#f14c4c'];
  const MAX_BUF = 500;

  let _minLevel = LEVELS.INFO;   // change to DEBUG during dev
  let _buffer   = [];
  let _toastEl  = null;
  let _toastTimer = null;

  // ── Core log ──────────────────────────────────────────────
  function _log(level, module, ...args) {
    if (level < _minLevel) return;

    const entry = {
      t:      Date.now(),
      ts:     new Date().toISOString(),
      level:  LABELS[level],
      module,
      msg:    args.map(a => {
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`;
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch(_) { return String(a); } }
        return String(a);
      }).join(' '),
    };

    // Circular buffer
    _buffer.push(entry);
    if (_buffer.length > MAX_BUF) _buffer.shift();

    // Browser console
    const pfx = `%c[${entry.level}] [${module}]`;
    const style = `color:${COLORS[level]};font-weight:${level >= LEVELS.WARN ? 'bold' : 'normal'}`;
    if (level === LEVELS.ERROR)  console.error(pfx, style, ...args);
    else if (level === LEVELS.WARN) console.warn(pfx, style, ...args);
    else console.log(pfx, style, ...args);

    // Toast for ERROR
    if (level >= LEVELS.ERROR) _showToast(entry.msg);
  }

  // ── Public shortcuts ──────────────────────────────────────
  function debug(module, ...a) { _log(LEVELS.DEBUG, module, ...a); }
  function info (module, ...a) { _log(LEVELS.INFO,  module, ...a); }
  function warn (module, ...a) { _log(LEVELS.WARN,  module, ...a); }
  function error(module, ...a) { _log(LEVELS.ERROR, module, ...a); }

  // ── Toast notification ────────────────────────────────────
  function _ensureToastEl() {
    if (_toastEl) return;
    _toastEl = document.createElement('div');
    _toastEl.id = 'dc-error-toast';
    Object.assign(_toastEl.style, {
      position:     'fixed',
      bottom:       '36px',
      left:         '50%',
      transform:    'translateX(-50%)',
      background:   '#2d1010',
      border:       '1px solid #f14c4c',
      borderRadius: '6px',
      color:        '#f9a',
      fontFamily:   'Segoe UI, sans-serif',
      fontSize:     '12px',
      padding:      '8px 16px',
      zIndex:       '99999',
      maxWidth:     '480px',
      boxShadow:    '0 4px 16px rgba(0,0,0,.7)',
      display:      'none',
      lineHeight:   '1.4',
    });
    document.body.appendChild(_toastEl);
  }

  function _showToast(msg) {
    _ensureToastEl();
    const short = msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
    _toastEl.textContent = '⚠ ' + short;
    _toastEl.style.display = 'block';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { _toastEl.style.display = 'none'; }, 6000);
  }

  // ── Global error handlers ─────────────────────────────────
  function _installGlobalHandlers() {
    window.addEventListener('error', (e) => {
      error('Global', `Uncaught: ${e.message}`, `at ${e.filename}:${e.lineno}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason instanceof Error
        ? `${e.reason.message}\n${e.reason.stack}`
        : String(e.reason);
      error('Promise', `Unhandled rejection: ${reason}`);
    });
  }

  // ── Try/catch wrapper ─────────────────────────────────────
  /**
   * Wraps a function call in try/catch, logs the error and
   * optionally shows a user-friendly message.
   *
   * @param {string}   module   — name for the log entry
   * @param {Function} fn       — function to call
   * @param {*}        fallback — value to return on error (default null)
   */
  function guard(module, fn, fallback = null) {
    try {
      const result = fn();
      if (result && typeof result.catch === 'function') {
        return result.catch(err => {
          error(module, err);
          return fallback;
        });
      }
      return result;
    } catch (err) {
      error(module, err);
      return fallback;
    }
  }

  // ── Download log buffer ───────────────────────────────────
  function downloadLogs() {
    const lines = _buffer.map(e =>
      `[${e.ts}] [${e.level}] [${e.module}] ${e.msg}`
    ).join('\n');
    const blob = new Blob([lines], { type: 'text/plain' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `DentalCAD_log_${new Date().toISOString().replace(/[:.]/g,'-')}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  function setLevel(levelName) {
    const l = LEVELS[levelName?.toUpperCase()];
    if (l !== undefined) _minLevel = l;
  }

  function getBuffer() { return [..._buffer]; }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    _installGlobalHandlers();
    info('Logger', `DentalCAD Logger v1 initialised — level: ${LABELS[_minLevel]}`);
    // Expose to DevTools
    window.DentalCADLogger = { debug, info, warn, error, guard, downloadLogs, setLevel, getBuffer };
  }

  return { init, debug, info, warn, error, guard, downloadLogs, setLevel, getBuffer };
})();
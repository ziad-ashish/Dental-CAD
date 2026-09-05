/**
 * app.js — Main application controller v4
 * New: Logger init, WallThickness heatmap, MarginDetector,
 *      ToothLibrary, Articulator, Validator, IndexedDB autosave
 *
 * Wires together:
 *  - Viewport (3D, real mesh loading)
 *  - STLParser (real binary/ASCII STL + OBJ)
 *  - ProjectIO (real JSON .dcad save/load)
 *  - UndoRedo  (Ctrl+Z / Ctrl+Shift+Z)
 *  - Tools     (MarginLine, Sculpt, Smooth, Measure, SectionCut)
 *  - Wizard    (7-step flow)
 *  - DentalChart (32-tooth FDI)
 *  - Modals, menus, toolbar, status bar, dock panels
 */

document.addEventListener('DOMContentLoaded', () => {

  // ── Application version (single source of truth) ──────────
  const APP_VERSION = 'v3.0';
  const APP_NAME    = 'DentalCAD';

  // Stamp version into all visible UI locations at runtime
  document.title = `${APP_NAME} — Professional Dental Design System`;
  document.querySelectorAll('[data-app-version]').forEach(el => {
    el.textContent = el.dataset.appVersion === 'full'
      ? `${APP_NAME} ${APP_VERSION}`
      : APP_VERSION;
  });

  // ═══════════════════════════════════════════════════════════
  // SPLASH
  // ═══════════════════════════════════════════════════════════
  const splash = document.getElementById('splash');
  setTimeout(() => {
    splash.classList.add('fade');
    setTimeout(() => splash.remove(), 520);
  }, 2600);

  // ═══════════════════════════════════════════════════════════
  // GLOBAL STATE
  // ═══════════════════════════════════════════════════════════
  const state = {
    expertMode:    false,
    gridVisible:   true,
    wireframe:     false,
    activeTool:    null,
    currentFile:   null,   // File object of loaded scan
    meshStats:     null,   // { vertices, triangles, dimensions }
  };

  // ═══════════════════════════════════════════════════════════
  // STATUS BAR
  // ═══════════════════════════════════════════════════════════
  let _msgTimer = null;
  function setMsg(msg, duration = 3500) {
    const el = document.getElementById('sb-msg');
    el.textContent = msg;
    clearTimeout(_msgTimer);
    if (duration > 0) _msgTimer = setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, duration);
  }
  function setSbStep(name) { document.getElementById('sb-step').textContent = `Step: ${name}`; }
  function setSbCase(name) { document.getElementById('sb-case').textContent = `Case: ${name}`; }

  // ═══════════════════════════════════════════════════════════
  // CASE INFO BAR
  // ═══════════════════════════════════════════════════════════
  function updateCaseInfoBar(data) {
    const p = data.patient || '—';
    document.getElementById('ci-patient').textContent = `Patient: ${p}`;
    document.getElementById('ci-caseid').textContent  = `  |  Case ID: ${data.caseId || '—'}`;
    document.getElementById('ci-date').textContent    = `  |  Modified: ${data.date || '—'}`;
    setSbCase(p);
  }
  function setCaseInfoStep(name) {
    document.getElementById('ci-step').textContent = `  |  Step: ${name}`;
    setSbStep(name);
  }

  // ═══════════════════════════════════════════════════════════
  // UNDO / REDO wiring
  // ═══════════════════════════════════════════════════════════
  UndoRedo.onChange(({ canUndo, canRedo, undoLabel, redoLabel }) => {
    const u = document.getElementById('tb-undo');
    const r = document.getElementById('tb-redo');
    if (u) { u.disabled = !canUndo; u.title = canUndo ? `Undo: ${undoLabel}` : 'Nothing to undo'; }
    if (r) { r.disabled = !canRedo; r.title = canRedo ? `Redo: ${redoLabel}` : 'Nothing to redo'; }
    setMsg(canUndo ? `Undo available: ${undoLabel}` : '', 0);
  });

  // ═══════════════════════════════════════════════════════════
  // VIEWPORT
  // ═══════════════════════════════════════════════════════════
  const vpCanvas = document.getElementById('viewport-canvas');

  function resizeCanvas() {
    if (!vpCanvas) return;
    const c = vpCanvas.parentElement;
    if (!c) return;
    // Use offsetWidth/Height which reflect layout correctly even before first paint.
    // clientWidth can be 0 if the parent hasn't been laid out yet.
    const w = c.offsetWidth  || c.clientWidth  || 400;
    const h = c.offsetHeight || c.clientHeight || 300;
    if (w > 0) vpCanvas.width  = w;
    if (h > 0) vpCanvas.height = h;
  }

  // Wait two animation frames: first for layout, second for paint.
  // This guarantees offsetWidth/Height are non-zero when Viewport.init fires.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      resizeCanvas();
      Viewport.init(vpCanvas);
      window.addEventListener('resize', () => { resizeCanvas(); Viewport.resize(); });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // ENGINE INSTANCES  (MarginLineEngine + SculptingEngine)
  // Both are lazy-initialised the first time a mesh is loaded.
  // ═══════════════════════════════════════════════════════════
  let _marginEngine    = null;   // MarginLineEngine
  let _sculptEngine    = null;   // SculptingEngine
  let _crownEngine     = null;   // CrownGeneratorEngine
  let _occlusionEngine = null;   // OcclusionHeatmapEngine
  let _occlusionActive = false;  // is heatmap currently shown

  /** Call once after viewport is ready AND a mesh is loaded */
  function _initEngines() {
    const scene    = Viewport.getScene?.();
    const camera   = Viewport.getCamera?.();
    const renderer = Viewport.getRenderer?.();
    if (!scene || !camera || !renderer) return;

    // ── MarginLineEngine ──────────────────────────────────
    if (!_marginEngine) {
      _marginEngine = new MarginLineEngine(scene, camera, renderer);
      Logger?.info('App', 'MarginLineEngine initialised');
    }
    const mesh = Viewport.getCurrentMesh?.();
    if (mesh) _marginEngine.setTargetMesh(mesh);

    // ── SculptingEngine ───────────────────────────────────
    if (!_sculptEngine) {
      _sculptEngine = new SculptingEngine(scene, camera, renderer);
      Logger?.info('App', 'SculptingEngine initialised');
    }
    if (mesh) _sculptEngine.setTargetMesh(mesh);

    // ── CrownGeneratorEngine ──────────────────────────────
    if (!_crownEngine) {
      const vs = Viewport.getCurrentGeometry()?.userData?.importViewScale ?? 1;
      _crownEngine = new CrownGeneratorEngine(scene, { viewportScale: vs });
      Logger?.info('App', 'CrownGeneratorEngine initialised');
    }

    // ── OcclusionHeatmapEngine ────────────────────────────
    if (!_occlusionEngine) {
      _occlusionEngine = new OcclusionHeatmapEngine(renderer);
      Logger?.info('App', 'OcclusionHeatmapEngine initialised');
    }
  }

  /** Re-target engines when a new mesh is loaded */
  function _retargetEngines() {
    const mesh = Viewport.getCurrentMesh?.();
    if (!mesh) return;
    _marginEngine?.setTargetMesh(mesh);
    _sculptEngine?.setTargetMesh(mesh);
  }

  // View preset buttons
  document.querySelectorAll('.vp-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.vp-btn[data-view]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Viewport.setView(btn.dataset.view);
    });
  });

  // Wireframe
  const wireBtn = document.getElementById('vp-wireframe');
  wireBtn.addEventListener('click', () => {
    state.wireframe = !state.wireframe;
    wireBtn.classList.toggle('active', state.wireframe);
    Viewport.setWireframe(state.wireframe);
  });

  // Grid
  const gridBtn = document.getElementById('vp-grid');
  gridBtn.addEventListener('click', () => {
    state.gridVisible = !state.gridVisible;
    gridBtn.classList.toggle('active', !state.gridVisible);
    Viewport.setGridVisible(state.gridVisible);
  });

  // ═══════════════════════════════════════════════════════════
  // TOOL ACTIVATION
  // ═══════════════════════════════════════════════════════════
  function activateTool(name) {
    // Deactivate previous
    if (state.activeTool === name) {
      Tools.deactivateCurrent();
      _deactivateEngines();
      state.activeTool = null;
      document.querySelectorAll('.design-tool-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('active-tool-label').textContent = 'Active Tool: None';
      _hideSectionCutUI();
      _hideMeasureUI();
      _hideMarginLineUI();
      setMsg('Tool deactivated', 1500);
      return;
    }

    Tools.deactivateCurrent();
    _deactivateEngines();

    // Special UI per tool
    if (name === 'Cut View') {
      _showSectionCutUI();
    } else {
      _hideSectionCutUI();
    }

    if (name === 'Measure') {
      _showMeasureUI();
    } else {
      _hideMeasureUI();
    }

    if (name === 'Margin Line') {
      _showMarginLineUI();
      // Use the new MarginLineEngine if available, fall back to Tools
      if (_marginEngine) {
        _marginEngine.enable();
      } else {
        Tools.activateTool(name);
      }
    } else {
      _hideMarginLineUI();
      if (name === 'Sculpt' || name === 'Add Material') {
        _showSculptParams(name);
        if (_sculptEngine) {
          _sculptEngine.setMode('ADD');
          _sculptEngine.enable();
        } else {
          Tools.activateTool('Sculpt');
        }
      } else if (name === 'Remove Material') {
        _showSculptParams(name);
        if (_sculptEngine) {
          _sculptEngine.setMode('SUBTRACT');
          _sculptEngine.enable();
        } else {
          Tools.activateTool('Sculpt');
        }
      } else if (name === 'Smooth') {
        _showSculptParams(name);
        if (_sculptEngine) {
          _sculptEngine.setMode('SMOOTH');
          _sculptEngine.enable();
        } else {
          Tools.activateTool('Smooth');
        }
      } else {
        Tools.activateTool(name);
      }
    }

    state.activeTool = name;
    document.getElementById('active-tool-label').textContent = `Active Tool: ${name}`;
    document.getElementById('param-tool-name').textContent = name;
    const desc = document.querySelector(`.design-tool-btn[data-tool="${name}"]`)?.dataset.desc || '';
    document.getElementById('param-tool-desc').textContent = desc;
    setMsg(`Tool: ${name} — ${desc}`, 2500);
  }

  /** Stop both engines without touching Tools stack */
  function _deactivateEngines() {
    if (_marginEngine?.isActive)   _marginEngine.disable();
    if (_sculptEngine?.isActive)   _sculptEngine.disable();
  }

  document.querySelectorAll('.design-tool-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.design-tool-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      activateTool(this.dataset.tool);
    });
  });

  // Margin-line extra buttons — support both engines
  document.getElementById('btn-close-margin')?.addEventListener('click', () => {
    if (_marginEngine) { _marginEngine.updateSplineCurve(); }
    Tools.MarginLineTool.closeLine();
    setMsg('Margin line closed.');
  });
  document.getElementById('btn-toggle-close')?.addEventListener('click', () => {
    Tools.MarginLineTool.toggleClose();
    const closed = Tools.MarginLineTool.isClosed();
    // ── Feed real state into wizard caseData ─────────────────
    Wizard.getData().marginLineClosed = closed;
    setMsg(closed ? 'Margin line closed.' : 'Margin line opened.');
  });
  document.getElementById('btn-export-margin-obj')?.addEventListener('click', () => {
    const cnt = Tools.MarginLineTool.getCount();
    if (cnt < 2) { setMsg('⚠ Place at least 2 margin points before exporting.', 3000); return; }
    const caseId = Wizard.getData().caseId || 'margin';
    const fname  = `margin_line_${caseId.replace(/[^a-z0-9_\-]/gi,'_')}.obj`;
    Tools.MarginLineTool.exportAsOBJ(fname);
    const len = Tools.MarginLineTool.getTotalLengthMM().toFixed(2);
    setMsg(`Margin line exported: ${fname}  (${cnt} pts, ${len} mm)`);
  });
  document.getElementById('btn-clear-margin')?.addEventListener('click', () => {
    if (!confirm('Clear all margin line points?')) return;
    _marginEngine?.clear();
    Tools.MarginLineTool.clear();
    Tools.MarginLineTool.invalidateCurvatureCache?.();
    UndoRedo.clear();
    setMsg('Margin line cleared.');
  });

  // Section cut UI
  function _showSectionCutUI() { document.getElementById('section-cut-ui')?.classList.remove('hidden'); }
  function _hideSectionCutUI() {
    document.getElementById('section-cut-ui')?.classList.add('hidden');
    if (Tools.SectionCutTool.isActive()) Tools.SectionCutTool.disable();
  }
  document.querySelectorAll('.cut-axis-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.cut-axis-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      Tools.SectionCutTool.setAxis(this.dataset.axis);
    });
  });
  const cutSlider = document.getElementById('cut-offset-slider');
  if (cutSlider) cutSlider.addEventListener('input', function () {
    Tools.SectionCutTool.setOffset(parseFloat(this.value));
  });

  // Measure mode UI
  function _showMeasureUI() { document.getElementById('measure-ui')?.classList.remove('hidden'); }
  function _hideMeasureUI() {
    document.getElementById('measure-ui')?.classList.add('hidden');
    Tools.MeasureTool.clear();
  }
  document.querySelectorAll('.measure-mode-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.measure-mode-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      Tools.MeasureTool.clear();
      Tools.activateTool('Measure', { mode: this.dataset.mode });
    });
  });

  // Margin Line UI
  function _showMarginLineUI() {
    document.getElementById('margin-line-ui')?.classList.remove('hidden');
    // Register live counter callback
    Tools.MarginLineTool.onUpdate((count, closed) => {
      const el = document.getElementById('ml-point-count');
      const lenMM = Tools.MarginLineTool.getTotalLengthMM?.() ?? 0;
      const lenStr = lenMM > 0 ? `  |  ${lenMM.toFixed(2)} mm` : '';
      if (el) el.textContent = `Points: ${count}  ${closed ? '(closed ✓)' : '(open)'}${lenStr}`;
      const closeBtn = document.getElementById('btn-toggle-close');
      if (closeBtn) {
        closeBtn.textContent = closed ? '🔓 Open Line' : '⭕ Close Line';
        closeBtn.disabled = count < 3;
      }
      const exportBtn = document.getElementById('btn-export-margin-obj');
      if (exportBtn) exportBtn.disabled = count < 2;
    });
    // Initial state
    const count  = Tools.MarginLineTool.getCount();
    const closed = Tools.MarginLineTool.isClosed();
    const lenMM  = Tools.MarginLineTool.getTotalLengthMM?.() ?? 0;
    const lenStr = lenMM > 0 ? `  |  ${lenMM.toFixed(2)} mm` : '';
    const el = document.getElementById('ml-point-count');
    if (el) el.textContent = `Points: ${count}  ${closed ? '(closed ✓)' : '(open)'}${lenStr}`;
    const closeBtn = document.getElementById('btn-toggle-close');
    if (closeBtn) { closeBtn.textContent = closed ? '🔓 Open Line' : '⭕ Close Line'; closeBtn.disabled = count < 3; }
    const exportBtn = document.getElementById('btn-export-margin-obj');
    if (exportBtn) exportBtn.disabled = count < 2;
  }

  function _hideMarginLineUI() {
    document.getElementById('margin-line-ui')?.classList.add('hidden');
    Tools.MarginLineTool.onUpdate(null);
  }

  // Sculpt params live update
  function _showSculptParams(toolName) {
    const radiusEl   = document.getElementById('sculpt-radius');
    const strengthEl = document.getElementById('sculpt-strength');
    if (radiusEl)   radiusEl.addEventListener('input', _updateSculptParams);
    if (strengthEl) strengthEl.addEventListener('input', _updateSculptParams);
  }
  function _updateSculptParams() {
    const r   = parseFloat(document.getElementById('sculpt-radius')?.value   || 0.35);
    const s   = parseFloat(document.getElementById('sculpt-strength')?.value || 0.008);
    const sub = document.getElementById('sculpt-subtract')?.checked || false;
    const falloffBtn = document.querySelector('.falloff-btn.active');
    const falloff    = falloffBtn?.dataset.falloff || 'smooth';
    // Update legacy Tools.SculptTool
    Tools.SculptTool.setParams(r, s, sub, falloff);
    Tools.SmoothTool.setFalloff?.(falloff);
    // Update new SculptingEngine
    if (_sculptEngine) {
      _sculptEngine.setRadius(r);
      _sculptEngine.setIntensity(s);
      if (sub) _sculptEngine.setMode('SUBTRACT');
    }
  }

  // Falloff button wiring
  document.querySelectorAll('.falloff-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.falloff-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      const falloff = this.dataset.falloff;
      Tools.SculptTool.setFalloff?.(falloff);
      Tools.SmoothTool.setFalloff?.(falloff);
      if (_sculptEngine) {
        // SculptingEngine doesn't have setFalloff yet — it uses Gaussian internally
        // We pass via setParams next time params are updated
      }
      setMsg(`Brush falloff: ${falloff}`, 1500);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // MENU BAR
  // ═══════════════════════════════════════════════════════════
  document.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = item.classList.contains('open');
      document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
  });
  document.querySelectorAll('.menu-entry[data-action]').forEach(e => {
    e.addEventListener('click', () => handleMenuAction(e.dataset.action));
  });

  function handleMenuAction(action) {
    document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
    switch (action) {
      case 'new-case':      _newCase();          break;
      case 'open-case':     _openCase();         break;
      case 'save':          _saveProject();      break;
      case 'save-as':       _saveProject();      break;
      case 'recent-files':  _openRecentModal();  break;
      case 'import-scan':   Wizard.goTo(1);      break;
      case 'export':        Wizard.goTo(6);      break;
      case 'exit':          if (confirm('Close DentalCAD?')) window.close(); break;
      case 'undo':          _doUndo();           break;
      case 'redo':          _doRedo();           break;
      case 'mirror':        _mirrorCurrentMesh(); break;
      case 'reset-library': _resetToSelectedLibrary(); break;
      case 'view-front':    Viewport.setView('front'); break;
      case 'view-top':      Viewport.setView('top');   break;
      case 'view-side':     Viewport.setView('side');  break;
      case 'toggle-grid':   gridBtn.click();     break;
      case 'toggle-wire':   wireBtn.click();     break;
      case 'toggle-left':   document.getElementById('left-dock').classList.toggle('hidden');  break;
      case 'toggle-right':  document.getElementById('right-dock').classList.toggle('hidden'); break;
      case 'modules':       openModal('modules-modal'); break;
      case 'mod-crown':     openModal('modules-modal'); setMsg('Crown & Bridge module selected.'); break;
      case 'mod-implant':   openModal('modules-modal'); setMsg('Implant module selected.'); break;
      case 'mod-denture':   openModal('modules-modal'); setMsg('Full Denture module selected.'); break;
      case 'mod-model':     openModal('modules-modal'); setMsg('Model Creator module selected.'); break;
      case 'mod-guide':     openModal('modules-modal'); setMsg('Surgical Guide module selected.'); break;
      case 'shortcuts':     openModal('shortcuts-modal'); break;
      case 'about':         openModal('about-modal'); break;
      case 'margin-line':   activateTool('Margin Line'); break;
      case 'measure':       activateTool('Measure'); break;
      case 'occlusion':     activateTool('Occlusion'); break;
      case 'cut-view':      activateTool('Cut View'); break;
      case 'folder-watch':  openModal('folder-watch-modal'); break;
      default: setMsg(`${action} (placeholder)`);
    }
  }

  function _mirrorCurrentMesh() {
    const geo = Viewport.getCurrentGeometry?.(), attr = geo?.getAttribute('position');
    if (!attr) { setMsg('Load a design before mirroring.', 2500); return; }
    const before = new Float32Array(attr.array), after = new Float32Array(before);
    for (let i = 0; i < after.length; i += 3) after[i] = -after[i];
    const apply = values => { attr.array.set(values); attr.needsUpdate = true; geo.computeVertexNormals(); Viewport.render?.(); };
    UndoRedo.push(new UndoRedo.MeshStateCommand('Mirror design', before, after, apply));
    ProjectIO.markDirty(); _scheduleAutoSave(); setMsg('Design mirrored across the midline.');
  }

  function _resetToSelectedLibrary() {
    const card = document.querySelector('#lib-step-grid .lib-card.selected') || document.querySelector('.lib-thumb.selected');
    if (!card) { setMsg('Select a tooth library shape first.', 2500); return; }
    _loadLibraryShape(card);
  }

  // ═══════════════════════════════════════════════════════════
  // TOOLBAR BUTTONS
  // ═══════════════════════════════════════════════════════════
  document.getElementById('mode-btn').addEventListener('click', function () {
    state.expertMode = !state.expertMode;
    this.classList.toggle('expert', state.expertMode);
    this.textContent = state.expertMode ? '🧙 Wizard Mode' : '⚙ Expert Mode';
    document.getElementById('wizard-panel').classList.toggle('hidden', state.expertMode);
    const badge = document.getElementById('case-info-bar').querySelector('.mode-badge');
    badge.classList.toggle('expert', state.expertMode);
    badge.textContent = state.expertMode ? 'EXPERT MODE' : 'WIZARD MODE';
    setMsg(state.expertMode ? 'Expert Mode — use toolbar tools directly.' : 'Wizard Mode activated.');
  });

  document.getElementById('tb-modules-btn').addEventListener('click', () => openModal('modules-modal'));

  // Undo / Redo toolbar buttons
  document.getElementById('tb-undo')?.addEventListener('click', _doUndo);
  document.getElementById('tb-redo')?.addEventListener('click', _doRedo);

  function _doUndo() {
    const label = UndoRedo.undo();
    if (label) setMsg(`Undone: ${label}`);
    else       setMsg('Nothing to undo.', 1500);
    Viewport.render();
  }
  function _doRedo() {
    const label = UndoRedo.redo();
    if (label) setMsg(`Redone: ${label}`);
    else       setMsg('Nothing to redo.', 1500);
    Viewport.render();
  }

  // ═══════════════════════════════════════════════════════════
  // RESIZE HANDLES
  // ═══════════════════════════════════════════════════════════
  initResize('left-resize',   'left-dock',    'h-fwd');
  initResize('right-resize',  'right-dock',   'h-rev');
  initResize('wizard-resize', 'wizard-panel', 'v-rev');

  function initResize(handleId, targetId, dir) {
    const handle = document.getElementById(handleId);
    const target = document.getElementById(targetId);
    if (!handle || !target) return;
    let dragging = false, startX = 0, startY = 0, startSize = 0;
    handle.addEventListener('mousedown', e => {
      dragging  = true;
      startX    = e.clientX; startY = e.clientY;
      startSize = dir === 'v-rev' ? target.offsetHeight : target.offsetWidth;
      handle.classList.add('dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      if (dir === 'h-fwd') {
        target.style.width  = Math.max(180, Math.min(420, startSize + (e.clientX - startX))) + 'px';
      } else if (dir === 'h-rev') {
        target.style.width  = Math.max(180, Math.min(420, startSize - (e.clientX - startX))) + 'px';
      } else {
        target.style.height = Math.max(180, Math.min(window.innerHeight * 0.8, startSize - (e.clientY - startY))) + 'px';
      }
      Viewport.resize();
    });
    window.addEventListener('mouseup', () => { dragging = false; handle.classList.remove('dragging'); });
  }

  // ═══════════════════════════════════════════════════════════
  // LEFT DOCK — Case Tree
  // ═══════════════════════════════════════════════════════════
  function updateCaseTree(data) {
    document.getElementById('ct-patient').textContent      = `👤 Patient: ${data.patient || '—'}`;
    document.getElementById('ct-date').textContent         = `📅 Date: ${data.date || '—'}`;
    document.getElementById('ct-restoration').textContent  = `🔨 Restoration: ${data.restoration || '—'}`;
    document.getElementById('ct-scanner').textContent      = `📡 Scanner: ${data.scanner || '—'}`;
    document.getElementById('ct-jaw').textContent          = `⬛ Jaw: ${data.jaw || '—'}`;
    const teethEl = document.getElementById('ct-teeth-list');
    teethEl.innerHTML = '';
    const teeth = data.selectedTeeth || [];
    if (teeth.length) {
      teeth.forEach(t => {
        const d = document.createElement('div');
        d.className = 'tree-item child';
        d.textContent = `🦷 #${t}`;
        teethEl.appendChild(d);
      });
    } else {
      const d = document.createElement('div');
      d.className = 'tree-item child';
      d.style.color = '#444';
      d.textContent = '(none selected)';
      teethEl.appendChild(d);
    }
    updateCaseInfoBar(data);
  }

  document.querySelectorAll('.tree-toggle').forEach(item => {
    item.addEventListener('click', () => item.classList.toggle('expanded'));
  });
  document.querySelectorAll('.module-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.module-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      setMsg(`Module: ${this.dataset.module}`);
    });
  });

  // ── RIGHT DOCK — tooth library thumbs ──────────────────
  // Note: lib-thumb click handlers wired in §4.3 below

  // ═══════════════════════════════════════════════════════════
  // DIRTY / UNSAVED-CHANGES TRACKING
  // ═══════════════════════════════════════════════════════════
  // Note: onDirtyChange with indicator color logic is wired in §5.2 below.
  // Here we only handle the document title dot:
  ProjectIO.onDirtyChange((dirty) => {
    const title  = document.title.replace(/^• /, '');
    document.title = dirty ? ('• ' + title) : title;
  });

  // Mark dirty whenever wizard data changes
  Wizard.init((stepIdx, stepName) => {
    setCaseInfoStep(stepName);
    updateCaseTree(Wizard.getData());
    ProjectIO.markDirty();
    _scheduleAutoSave();
    // When user navigates to the Export step, refresh the summary
    if (stepIdx === 6) {
      setTimeout(() => {
        _updateExportMeshSummary?.();
        _updateExportSizePreview?.();
      }, 50);
    }
  });

  // ── Auto-save throttle ────────────────────────────────────
  let _autoSaveTimer = null;
  function _scheduleAutoSave() {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(() => {
      const data = Wizard.getData();
      const geo  = Viewport.getCurrentGeometry();
      const ml   = { points: Tools.MarginLineTool.getPoints(), closed: Tools.MarginLineTool.isClosed() };
      ProjectIO.autoSave(data, geo, { marginLine: ml });
    }, 4000); // debounce 4 s
  }


  const dateInp = document.getElementById('inp-date');
  if (dateInp) dateInp.value = new Date().toISOString().split('T')[0];
  const caseIdInp = document.getElementById('inp-caseid');
  if (caseIdInp) caseIdInp.value = `CASE-${new Date().getFullYear()}-0001`;

  document.querySelectorAll('.jaw-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.jaw-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
    });
  });

  // ── STEP 2: Scan Import (REAL parsing) ───────────────────
  window._scanFile = null;
  const dropZone = document.getElementById('drop-zone');

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) _loadRealFile(e.dataTransfer.files[0]);
  });
  dropZone.addEventListener('click', () => document.getElementById('scan-file-input').click());
  document.getElementById('scan-file-input').addEventListener('change', function () {
    if (this.files[0]) _loadRealFile(this.files[0]);
  });
  document.getElementById('btn-browse-scan').addEventListener('click', () =>
    document.getElementById('scan-file-input').click()
  );
  document.getElementById('btn-demo-scan').addEventListener('click', _loadDemoScan);

  async function _loadRealFile(file) {
    window._scanFile = file.name;
    state.currentFile = file;
    _showScanProgress('Parsing ' + file.name + '…');

    try {
      const { geometry, stats } = await STLParser.parseFile(file);
      geometry.userData.stats = stats;
      state.meshStats = stats;
      Viewport.loadGeometry(geometry, stats);
      _onScanLoaded(file.name, file.size, stats);
      UndoRedo.clear();
      ProjectIO.markDirty();
      _scheduleAutoSave();
      _initEngines();
      _retargetEngines();
    } catch (err) {
      _hideScanProgress();
      document.getElementById('scan-status').textContent = `⚠ Parse error: ${err.message}`;
      document.getElementById('scan-status').style.color = 'var(--red)';
      console.error('STL parse error:', err);
    }
  }

  function _loadDemoScan() {
    // Generate a parametric tooth-like mesh and push it as geometry
    _showScanProgress('Loading demo scan…');
    setTimeout(() => {
      const geo = _buildDemoGeometry();
      const stats = {
        vertices:   geo.getAttribute('position').count,
        triangles:  geo.getAttribute('position').count / 3,
        dimensions: { x: '18.40', y: '22.10', z: '14.70' },
        rawSize: 0,
      };
      geo.userData.stats = stats;
      state.meshStats = stats;
      Viewport.loadGeometry(geo, stats);
      _onScanLoaded('DEMO_upper_incisor.stl', 1240832, stats, true);
      UndoRedo.clear();
      ProjectIO.markDirty();
      _scheduleAutoSave();
      _initEngines();
      _retargetEngines();
    }, 400);
  }

  function _buildDemoGeometry() {
    // Icosphere subdivided = smooth crown + cylinder root
    const merge  = [];
    // Crown — sphere with y-flatten
    const sph    = new THREE.SphereGeometry(1.0, 32, 24);
    const sPos   = sph.attributes.position;
    for (let i = 0; i < sPos.count; i++) {
      const y = sPos.getY(i);
      if (y > 0.5) sPos.setY(i, 0.5 + (y - 0.5) * 0.4);
    }
    sph.computeVertexNormals();
    merge.push({ geo: sph, offY: 0 });

    const cyl = new THREE.CylinderGeometry(0.18, 0.06, 1.8, 20);
    merge.push({ geo: cyl, offY: -1.7 });

    // Merge into one non-indexed geometry
    const allPos = [], allNor = [];
    for (const { geo, offY } of merge) {
      const p = geo.attributes.position;
      const n = geo.attributes.normal;
      for (let i = 0; i < p.count; i++) {
        allPos.push(p.getX(i), p.getY(i) + offY, p.getZ(i));
        allNor.push(n.getX(i), n.getY(i), n.getZ(i));
      }
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allPos), 3));
    out.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(allNor), 3));
    return out;
  }

  function _showScanProgress(msg) {
    const prog   = document.getElementById('scan-progress');
    const fill   = document.getElementById('scan-prog-fill');
    const status = document.getElementById('scan-status');
    prog.classList.remove('hidden');
    fill.style.width   = '0%';
    status.textContent = msg;
    status.style.color = 'var(--accent-dim)';
    // Animate progress bar to ~80% while parsing
    let pct = 0;
    const iv = setInterval(() => {
      pct = Math.min(pct + 3, 80);
      fill.style.width = pct + '%';
      if (pct >= 80) clearInterval(iv);
    }, 30);
    status._progressIv = iv;
  }

  function _hideScanProgress() {
    const prog = document.getElementById('scan-progress');
    prog.classList.add('hidden');
    clearInterval(document.getElementById('scan-status')?._progressIv);
  }

  function _onScanLoaded(name, size, stats, isDemo = false) {
    const fill   = document.getElementById('scan-prog-fill');
    const prog   = document.getElementById('scan-progress');
    const status = document.getElementById('scan-status');
    clearInterval(status._progressIv);
    fill.style.width = '100%';
    setTimeout(() => prog.classList.add('hidden'), 300);

    dropZone.classList.add('loaded');
    dropZone.querySelector('.drop-icon').textContent  = '✅';
    dropZone.querySelector('.drop-title').textContent = name;
    dropZone.querySelector('.drop-title').style.color = 'var(--green)';
    const sz = size < 1048576 ? `${(size/1024).toFixed(1)} KB` : `${(size/1048576).toFixed(2)} MB`;
    dropZone.querySelector('.drop-sub').textContent = isDemo ? 'Demo scan — Ready' : `Size: ${sz} — Ready`;

    // Real stats from parser
    document.getElementById('scan-info-card').classList.remove('hidden');
    document.getElementById('scan-fname').textContent   = name;
    document.getElementById('scan-format').textContent  = (name.split('.').pop() || 'STL').toUpperCase();
    document.getElementById('scan-verts').textContent   = stats.vertices.toLocaleString();
    document.getElementById('scan-tris').textContent    = stats.triangles.toLocaleString();
    document.getElementById('scan-dims').textContent    =
      `${stats.dimensions.x} × ${stats.dimensions.y} × ${stats.dimensions.z} mm`;

    status.textContent = '✔ Scan loaded and displayed in viewport.';
    status.style.color = 'var(--green)';
    setMsg(`Scan loaded: ${name} — ${stats.triangles.toLocaleString()} triangles`);

    // Store filename in wizard data so it's saved with the project
    window._lastScanFileName = name;

    // Pre-populate export step summary
    _updateExportMeshSummary?.();
    _updateExportSizePreview?.();
  }

  // ═══════════════════════════════════════════════════════════
  // §8 — SMART SUGGESTIONS
  // ═══════════════════════════════════════════════════════════

  // ── Smart Margin button ───────────────────────────────────
  document.getElementById('btn-smart-margin')?.addEventListener('click', () => {
    const geo = Viewport.getCurrentGeometry();
    if (!geo) { setMsg('Load a scan first.', 2500); return; }
    if (typeof SmartSuggestions === 'undefined') {
      setMsg('SmartSuggestions not loaded.', 2000); return;
    }

    const warningBanner = document.getElementById('margin-auto-suggest-banner');
    if (warningBanner) warningBanner.classList.remove('hidden');

    setMsg('Running Smart Margin Suggestion…', 0);

    setTimeout(() => {
      try {
        const edgeW = 0.4;   // balance curvature vs edge proximity
        const result = SmartSuggestions.suggestMargin(geo, {
          topPct:     12,
          smoothIter: 5,
          edgeWeight: edgeW,
          maxGapMM:   0.5,
        });

        if (!result.points.length) {
          setMsg('Smart Suggestion: not enough geometry — try Auto-Detect.', 4000);
          return;
        }

        // Clear both engines before loading
        Tools.MarginLineTool.clear();
        _marginEngine?.clear();
        Tools.MarginLineTool.invalidateCurvatureCache?.();

        result.points.forEach(pt => {
          Tools.MarginLineTool._restorePoint(pt);
          _marginEngine?.addMarginPoint(pt);
        });
        Tools.MarginLineTool._restoreClose(true);
        Viewport.render();

        const s = result.stats;
        setMsg(
          `✨ Smart Suggestion: ${s.pointCount} pts · ${s.estimatedLengthMM} mm` +
          `${s.gapsFilled ? ` · ${s.gapsFilled} gap(s) filled` : ''} — review before use`
        );

        if (typeof Logger !== 'undefined') Logger.info('SmartSuggest', result.disclaimer);
      } catch (err) {
        if (typeof Logger !== 'undefined') Logger.error('SmartSuggest', err);
        setMsg(`Smart Suggestion error: ${err.message}`, 4000);
      }
    }, 0);
  });

  // ── Restoration Hint — fires when tooth selection changes ─
  // DentalChart.render callback already set — we hook onto the existing
  // dental-chart change callback and Wizard step changes:
  function _updateRestorationHint() {
    if (typeof SmartSuggestions === 'undefined') return;
    const teeth  = DentalChart.getSelected();
    const banner = document.getElementById('restoration-hint-banner');
    if (!banner) return;

    if (!teeth.length) { banner.style.display = 'none'; return; }

    const hint = SmartSuggestions.hintRestoration(teeth);
    if (!hint.primary) { banner.style.display = 'none'; return; }

    const confColor = { high: '#4ec9b0', medium: '#e8c065', low: '#94a3b8' };
    const confLabel = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

    document.getElementById('hint-primary').innerHTML =
      `Suggested: <b style="color:#e2e8f0">${hint.primary}</b>` +
      `&nbsp;<span style="font-size:9px;padding:1px 6px;border-radius:10px;` +
      `background:rgba(255,255,255,0.06);color:${confColor[hint.confidence]}">` +
      `${confLabel[hint.confidence]}</span>`;

    document.getElementById('hint-rationale').textContent = hint.rationale;

    const altEl = document.getElementById('hint-alternatives');
    if (hint.alternatives.length) {
      altEl.textContent = `Also consider: ${hint.alternatives.join(' · ')}`;
    } else {
      altEl.textContent = '';
    }

    banner.style.display = 'block';
  }

  // Wire into dental chart change
  DentalChart.render(
    document.getElementById('dental-chart-container'),
    teeth => {
      const el = document.getElementById('tooth-selection-summary');
      if (el) el.textContent = teeth.length
        ? `Selected: ${teeth.join(', ')}  (${teeth.length} teeth)`
        : 'No teeth selected.';
      _updateRestorationHint();
    }
  );

  // Also update hint when user manually navigates to Restoration step
  (function _patchGoToForHint() {
    const _prevGoTo = Wizard.goTo.bind(Wizard);
    Wizard.goTo = function (index) {
      _prevGoTo(index);
      if (index === 3) setTimeout(_updateRestorationHint, 80);  // Restoration Type = step 4
    };
  })();

  // Dental chart selection buttons
  document.getElementById('btn-sel-upper')?.addEventListener('click', () => {
    DentalChart.selectAll('upper'); _updateRestorationHint();
  });
  document.getElementById('btn-sel-lower')?.addEventListener('click', () => {
    DentalChart.selectAll('lower'); _updateRestorationHint();
  });
  document.getElementById('btn-sel-clear')?.addEventListener('click', () => {
    DentalChart.clearAll();
    const banner = document.getElementById('restoration-hint-banner');
    if (banner) banner.style.display = 'none';
  });

  // ── STEP 4: Restoration type cards ──────────────────────
  // Note: click handler with undo support is wired in §4.5 below

  // ── STEP 5: Design Tools (handled above in activateTool) ─

  // ── STEP 6: Library selection ────────────────────────────
  // Note: lib-card click + dblclick wired in §4.3 below with real 3D model loading
  document.querySelectorAll('#lib-step-grid .lib-card').forEach(card => {
    // Filter buttons and search are still wired here
  });
  document.querySelectorAll('.lib-filter-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.lib-filter-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      const f = this.dataset.filter;
      document.querySelectorAll('#lib-step-grid .lib-card').forEach(c => {
        c.classList.toggle('hidden', f !== 'all' && (c.dataset.typeGroup || 'all') !== f);
      });
    });
  });
  document.getElementById('lib-search').addEventListener('input', function () {
    const q = this.value.toLowerCase();
    document.querySelectorAll('#lib-step-grid .lib-card').forEach(c => {
      c.classList.toggle('hidden', q.length > 0 &&
        !(c.dataset.lib || '').toLowerCase().includes(q) &&
        !(c.dataset.mfr || '').toLowerCase().includes(q));
    });
  });

  // ── STEP 7: Review & Export (REAL export) ────────────────
  document.getElementById('btn-export').addEventListener('click', _doExport);
  document.getElementById('btn-save-project').addEventListener('click', _saveProject);

  // Live size-estimate preview when format changes
  function _updateExportSizePreview() {
    const geo = Viewport.getCurrentGeometry();
    const fmt = document.getElementById('export-format')?.value || 'STL Binary';
    const el  = document.getElementById('export-size-preview');
    if (!el) return;
    if (!geo) { el.textContent = '— load a scan to see size estimate'; return; }
    const bytes = STLParser.estimateExportSize(geo, fmt);
    el.textContent = `Estimated file size: ~${STLParser.formatBytes(bytes)}`;
  }

  document.getElementById('export-format')?.addEventListener('change', () => {
    _updateExportSizePreview();
    // Also update mesh summary
    _updateExportMeshSummary();
  });

  function _updateExportMeshSummary() {
    const geo = Viewport.getCurrentGeometry();
    if (!geo) return;
    const stats = geo.userData.stats || state.meshStats;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    if (stats) {
      set('esm-tris',  (stats.triangles || 0).toLocaleString());
      set('esm-verts', (stats.vertices  || 0).toLocaleString());
      if (stats.dimensions) {
        set('esm-dims', `${stats.dimensions.x} × ${stats.dimensions.y} × ${stats.dimensions.z} mm`);
      }
    } else {
      const pos = geo.getAttribute('position');
      const t   = Math.floor((pos?.count || 0) / 3);
      set('esm-tris',  t.toLocaleString());
      set('esm-verts', (pos?.count || 0).toLocaleString());
    }
  }

  function _doExport() {
    const fmt     = document.getElementById('export-format')?.value || 'STL Binary';
    const units   = document.getElementById('export-units')?.value  || 'mm';
    const inclML  = document.getElementById('export-margin-line')?.checked ?? true;
    const data    = Wizard.getData();
    const geo     = Viewport.getCurrentGeometry();

    if (!geo) {
      setMsg('⚠ No mesh loaded — load a scan or demo first.', 3500);
      document.getElementById('export-status').textContent = '⚠ No mesh loaded.';
      document.getElementById('export-status').style.color = 'var(--red)';
      return;
    }

    // Margin line points (optional annotation)
    const mlPoints = inclML ? Tools.MarginLineTool.getPoints() : [];

    const status = document.getElementById('export-status');
    const wrap   = document.getElementById('export-progress-wrap');
    const fill   = document.getElementById('export-prog-fill');
    status.textContent = 'Preparing export…';
    status.style.color = 'var(--accent-dim)';
    wrap.classList.remove('hidden');
    fill.style.width   = '0%';

    // Run the actual export asynchronously to keep UI responsive
    // Use setTimeout(0) to allow the DOM to update first
    setTimeout(() => {
      try {
        // Animate fill to 60% while computing
        let pct = 0;
        const iv = setInterval(() => {
          pct = Math.min(pct + 5, 60);
          fill.style.width = pct + '%';
        }, 20);

        const filename = ProjectIO.exportMesh(geo, fmt, data.caseId, {
          units,
          includeMarginLine: inclML && mlPoints.length > 0,
          marginLinePoints:  mlPoints,
        });

        clearInterval(iv);
        fill.style.width = '100%';
        setTimeout(() => wrap.classList.add('hidden'), 400);

        status.textContent = `✔ Exported: ${filename}`;
        status.style.color = 'var(--green)';
        if (fmt === 'OBJ') {
          status.textContent += '  +  .mtl material file';
        }
        setMsg(`Exported: ${filename}  (${STLParser.formatBytes(STLParser.estimateExportSize(geo, fmt))})`);
        ProjectIO.markDirty(); // export doesn't count as a save
      } catch (err) {
        wrap.classList.add('hidden');
        status.textContent = `⚠ Export failed: ${err.message}`;
        status.style.color = 'var(--red)';
        console.error('Export error:', err);
      }
    }, 0);
  }

  function _saveProject() {
    const data = Wizard.getData();
    // Collect margin line points from the active tool
    const ml = { points: Tools.MarginLineTool.getPoints(), closed: Tools.MarginLineTool.isClosed() };
    // Include which wizard step we're on
    data.wizardStep = Wizard.getStep();
    const geo = Viewport.getCurrentGeometry();
    ProjectIO.save(data, geo, { marginLine: ml });
    document.title = document.title.replace(/^• /, '');
    document.getElementById('unsaved-indicator')?.classList.add('hidden');
    setMsg(`✔ Project saved: DentalCAD_${(data.caseId||'Case').replace(/[^a-z0-9_\-]/gi,'_')}.dcad`);
  }

  async function _openCase() {
    if (ProjectIO.isDirty()) {
      if (!confirm('You have unsaved changes. Open a different case and discard them?')) return;
    }
    try {
      const result = await ProjectIO.load();
      _applyLoadedProject(result);
    } catch (err) {
      if (err.message !== 'No file selected') {
        setMsg(`⚠ Could not open: ${err.message}`, 4500);
        console.error('Open case error:', err);
      }
    }
  }

  // ── Central restore function used by both Open and Auto-save restore ──
  function _applyLoadedProject(result) {
    const { caseData, geometry, stats, marginLine, savedAt, wizardStep } = result;

    // 1. Restore form fields and dental chart
    _restoreCaseForm(caseData);

    // 2. Restore mesh
    if (geometry) {
      Viewport.loadGeometry(geometry, stats);
      state.meshStats = stats;
      _updateScanInfoPanel(caseData.scanFileName || 'Restored mesh', stats);
      _updateExportMeshSummary?.();
      _updateExportSizePreview?.();
      _initEngines();
      _retargetEngines();
    }

    // 3. Restore margin line
    if (marginLine?.length) {
      Tools.MarginLineTool.clear();
      _marginEngine?.clear();
      marginLine.forEach(([x, y, z]) => {
        Tools.MarginLineTool._restorePoint(new THREE.Vector3(x, y, z));
        _marginEngine?.addMarginPoint(new THREE.Vector3(x, y, z));
      });
      if (result.marginLineClosed || result.marginLine?.closed) {
        Tools.MarginLineTool._restoreClose(true);
      }
      Viewport.render();
    }

    // 4. Navigate wizard to correct step
    if (typeof wizardStep === 'number' && wizardStep >= 0) {
      Wizard.goTo(wizardStep);
    }

    // 5. Update UI
    updateCaseTree(caseData);
    updateCaseInfoBar(caseData);
    ProjectIO.markClean();
    UndoRedo.clear();

    const when = savedAt ? savedAt.split('T')[0] : '?';
    setMsg(`✔ Opened: ${caseData.patient || '—'} — saved ${when}`);
  }

  function _restoreCaseForm(data) {
    const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
    set('inp-patient',   data.patient);
    set('inp-caseid',    data.caseId);
    set('inp-date',      data.date);
    set('inp-clinician', data.clinician);
    set('inp-lab',       data.lab);

    // Scanner dropdown
    if (data.scanner) {
      const sel = document.getElementById('sel-scanner');
      if (sel) [...sel.options].forEach(o => { o.selected = o.value === data.scanner || o.textContent === data.scanner; });
    }

    // Jaw selection
    if (data.jaw) {
      document.querySelectorAll('.jaw-btn').forEach(b => b.classList.toggle('active', b.dataset.jaw === data.jaw));
    }

    // Teeth — use DentalChart.clearAll() then selectAll via internal toggle
    DentalChart.clearAll();
    if (data.selectedTeeth?.length) {
      // selectByNumbers drives internal selectedTeeth Set correctly
      DentalChart.selectByNumbers(data.selectedTeeth);
      const el = document.getElementById('tooth-selection-summary');
      if (el) el.textContent = `Selected: ${data.selectedTeeth.join(', ')}  (${data.selectedTeeth.length} teeth)`;
    }

    // Restoration type
    document.querySelectorAll('.rest-card').forEach(c => {
      const match = c.dataset.rest === data.restoration;
      c.classList.toggle('selected', match);
    });
    if (data.restoration) {
      const rl = document.getElementById('rest-selection-label');
      if (rl) rl.textContent = `Selected: ${data.restoration}`;
    }

    // Library item
    if (data.libraryItem) {
      document.querySelectorAll('#lib-step-grid .lib-card').forEach(c => {
        const match = c.dataset.lib === data.libraryItem;
        c.classList.toggle('selected', match);
        if (match) {
          document.getElementById('lib-detail-name')?.setAttribute('textContent', c.dataset.lib);
          document.getElementById('lib-detail-mfr')?.setAttribute('textContent',  c.dataset.mfr || '');
        }
      });
    }
  }

  // ── Helper: populate scan info panel from stats ────────────
  function _updateScanInfoPanel(filename, stats) {
    if (!stats) return;
    const card = document.getElementById('scan-info-card');
    if (card) card.classList.remove('hidden');
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('scan-fname',   filename);
    set('scan-format',  (filename.split('.').pop() || 'STL').toUpperCase());
    set('scan-verts',   (stats.vertices  || 0).toLocaleString());
    set('scan-tris',    (stats.triangles || 0).toLocaleString());
    if (stats.dimensions) {
      set('scan-dims', `${stats.dimensions.x} × ${stats.dimensions.y} × ${stats.dimensions.z} mm`);
    }
    // Update drop zone to show "restored" state
    const dz = document.getElementById('drop-zone');
    if (dz) {
      dz.classList.add('loaded');
      dz.querySelector('.drop-icon').textContent  = '✅';
      dz.querySelector('.drop-title').textContent = filename;
      dz.querySelector('.drop-title').style.color = 'var(--green)';
      dz.querySelector('.drop-sub').textContent   = `${(stats.triangles||0).toLocaleString()} triangles — Restored from project`;
    }
  }

  function _newCase() {
    if (ProjectIO.isDirty()) {
      if (!confirm('Start a new case? Unsaved changes will be lost.')) return;
    }
    Wizard.goTo(0);
    Viewport.resetPlaceholder();
    UndoRedo.clear();
    Tools.deactivateCurrent();
    Tools.MarginLineTool.clear();
    _marginEngine?.clear();
    _sculptEngine?.disable();
    _crownEngine?.dispose();
    if (_occlusionEngine && _occlusionActive) {
      _occlusionEngine.restoreAll();
      _occlusionActive = false;
      document.getElementById('tb-occlusion')?.classList.remove('active');
    }
    state.currentFile = null;
    state.meshStats   = null;
    // Reset form fields
    ['inp-patient','inp-clinician','inp-lab'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const ci = document.getElementById('inp-caseid');
    if (ci) ci.value = `CASE-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;
    const di = document.getElementById('inp-date');
    if (di) di.value = new Date().toISOString().split('T')[0];
    // Reset scan drop zone
    const dz = document.getElementById('drop-zone');
    if (dz) {
      dz.classList.remove('loaded');
      dz.querySelector('.drop-icon').textContent  = '📂';
      dz.querySelector('.drop-title').textContent = 'Drop scan file here';
      dz.querySelector('.drop-title').style.color = '';
      dz.querySelector('.drop-sub').textContent   = 'Supported: .stl  .obj  .ply (ASCII)';
    }
    document.getElementById('scan-info-card')?.classList.add('hidden');
    document.getElementById('scan-status').textContent = '';
    // Reset selections
    DentalChart.clearAll();
    document.querySelectorAll('.rest-card').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.jaw-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
    // Clear dirty state
    ProjectIO.markClean();
    Promise.resolve(ProjectIO.clearAutoSave()).catch(() => {});
    document.title = document.title.replace(/^• /, '');
    document.getElementById('unsaved-indicator')?.classList.add('hidden');
    setMsg('New case started.', 2000);
  }

  // ═══════════════════════════════════════════════════════════
  // RECENT FILES MODAL
  // ═══════════════════════════════════════════════════════════
  function _openRecentModal() {
    const list = document.getElementById('recent-list');
    list.innerHTML = '<div style="color:#555;font-size:13px;text-align:center;padding:24px 0">Loading…</div>';
    openModal('recent-modal');

    // getRecentFiles is async — must await
    Promise.resolve(ProjectIO.getRecentFiles()).then(recent => {
      list.innerHTML = '';
      if (!recent || !recent.length) {
        list.innerHTML = '<div style="color:#555;font-size:13px;text-align:center;padding:24px 0">No recent files.</div>';
        return;
      }
      recent.forEach(entry => {
        const row = document.createElement('div');
        row.style.cssText = `display:flex;align-items:center;gap:12px;padding:9px 12px;
          background:var(--bg3);border-radius:5px;cursor:pointer;
          border:1px solid transparent;transition:border-color .15s;`;
        row.onmouseenter = () => row.style.borderColor = 'var(--accent)';
        row.onmouseleave = () => row.style.borderColor = 'transparent';
        const when = entry.savedAt ? entry.savedAt.split('T')[0] : '?';
        row.innerHTML = `
          <span style="font-size:20px">📋</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:bold;color:var(--text);
                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${entry.patient || 'Unnamed patient'}
            </div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:2px">
              ${entry.filename || entry.caseId || '—'} &nbsp;·&nbsp; ${when}
            </div>
          </div>
          <span style="font-size:11px;color:var(--accent);white-space:nowrap">Open →</span>`;
        row.addEventListener('click', () => { closeModal('recent-modal'); _openCase(); });
        list.appendChild(row);
      });
    }).catch(err => {
      list.innerHTML = `<div style="color:var(--red);font-size:12px;padding:12px">Error: ${err.message}</div>`;
    });

    const clearBtn = document.getElementById('btn-clear-recent');
    if (clearBtn) {
      clearBtn.onclick = () => {
        Promise.resolve(ProjectIO.clearRecentFiles()).then(() => {
          list.innerHTML = '<div style="color:#555;font-size:13px;text-align:center;padding:24px 0">List cleared.</div>';
        });
      };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // MODALS
  // ═══════════════════════════════════════════════════════════
  function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
  function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.classList.remove('open'); });
  });
  document.querySelectorAll('.module-card').forEach(card => {
    card.addEventListener('click', function () {
      const name = this.querySelector('.module-card-name').textContent;
      closeModal('modules-modal');
      setMsg(`Module launched: ${name}`);
      document.querySelectorAll('.module-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.module === name);
      });
    });
  });
  document.getElementById('modules-search').addEventListener('input', function () {
    const q = this.value.toLowerCase();
    document.querySelectorAll('.module-card').forEach(c => {
      const n = c.querySelector('.module-card-name').textContent.toLowerCase();
      const d = c.querySelector('.module-card-desc').textContent.toLowerCase();
      c.classList.toggle('hidden', q.length > 0 && !n.includes(q) && !d.includes(q));
    });
  });

  // ═══════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ═══════════════════════════════════════════════════════════
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); _doUndo(); return; }
    if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); _doRedo(); return; }
    if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); _newCase(); return; }
    if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); _saveProject(); return; }
    if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); _openCase(); return; }
    if (ctrl && e.key.toLowerCase() === 'm') { e.preventDefault(); openModal('modules-modal'); return; }
    if (ctrl && e.key.toLowerCase() === 'e') { e.preventDefault(); Wizard.goTo(6); return; }

    // Space — toggle Expert/Wizard mode
    if (e.key === ' ' && !ctrl && !e.altKey) {
      e.preventDefault();
      document.getElementById('mode-btn')?.click();
      return;
    }

    // 1-7 — jump directly to wizard step (Wizard mode only)
    if (!state.expertMode && !ctrl && !e.altKey) {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= 7) {
        e.preventDefault();
        Wizard.goTo(num - 1);
        return;
      }
    }

    switch (e.key.toLowerCase()) {
      case 'g':      gridBtn.click(); break;
      case 'w':      wireBtn.click(); break;
      case 'escape':
        document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
        Tools.deactivateCurrent();
        state.activeTool = null;
        document.querySelectorAll('.design-tool-btn').forEach(b => b.classList.remove('active'));
        break;
      case 'f1':     e.preventDefault(); openModal('shortcuts-modal'); break;
      case 'm':      activateTool('Margin Line'); break;
      case 'd':      activateTool('Measure'); break;
      case 'x':      activateTool('Cut View'); break;
    }
  });

  // ═══════════════════════════════════════════════════════════
  // STARTUP: Logger + restore auto-save
  // ═══════════════════════════════════════════════════════════

  // Init logger first
  if (typeof Logger !== 'undefined') Logger.init();

  // Async auto-save check (IndexedDB)
  (async () => {
    const has = await ProjectIO.hasAutoSave();
    if (!has) return;

    const saved = await ProjectIO.loadAutoSave();
    if (!saved) return;

    const cd = saved?.caseData;

    /**
     * A saved case is "substantive" (worth asking to restore) if it has
     * at least one piece of real user-entered data.
     *
     * We explicitly exclude:
     *  - The default placeholder patient value '—'
     *  - Values that look like HTML placeholder text (start with "e.g.")
     *  - The auto-generated default Case ID (matches CASE-YYYY-#### pattern
     *    with no other real data alongside it)
     */
    function _isSubstantive(caseData) {
      if (!caseData) return false;

      const patient = (caseData.patient || '').trim();
      const caseId  = (caseData.caseId  || '').trim();

      const patientReal = patient.length > 0 &&
        patient !== '—' &&
        !patient.startsWith('e.g.') &&
        patient !== 'Unnamed';

      // Case ID is considered "real" only if user changed it from the default
      const defaultCaseIdPattern = /^CASE-\d{4}-\d+$/;
      const caseIdReal = caseId.length > 0 &&
        caseId !== '—' &&
        !defaultCaseIdPattern.test(caseId);

      const hasTeeth       = Array.isArray(caseData.selectedTeeth) && caseData.selectedTeeth.length > 0;
      const hasRestoration = caseData.restoration && caseData.restoration !== '—';
      const hasScan        = !!(caseData.scanFile || caseData.scanFileName);

      return patientReal || caseIdReal || hasTeeth || hasRestoration || hasScan;
    }

    if (_isSubstantive(cd)) {
      const when = saved.savedAt ? saved.savedAt.split('T')[0] : '';
      _showRestoreBanner(saved, when);
    } else {
      // Empty / default-only record — delete silently, don't show the banner
      await ProjectIO.clearAutoSave();
      if (typeof Logger !== 'undefined')
        Logger.info('AutoSave', 'Empty auto-save discarded silently');
    }
  })();

  function _showRestoreBanner(saved, when) {
    const banner = document.getElementById('restore-banner');
    const cd     = saved.caseData;
    // Build a human-readable label — prefer patient name, fall back to case ID
    const label  = (cd.patient && cd.patient !== '—' && cd.patient !== 'Unnamed')
      ? cd.patient
      : (cd.caseId && cd.caseId !== '—' ? cd.caseId : 'Previous session');

    if (!banner) {
      // Fallback: auto-restore without asking
      _applyLoadedProject(saved);
      setMsg(`Auto-save restored: ${label} (${when})`, 5000);
      return;
    }
    document.getElementById('restore-banner-text').textContent =
      `Auto-save found: ${label} — ${when}`;
    banner.classList.remove('hidden');
    document.getElementById('restore-btn-yes').onclick = () => {
      banner.classList.add('hidden');
      _applyLoadedProject(saved);
      setMsg(`Restored: ${saved.caseData.patient}`, 3000);
    };
    document.getElementById('restore-btn-no').onclick = () => {
      banner.classList.add('hidden');
      ProjectIO.clearAutoSave();
    };
  }

  // (startup message moved to §5 at bottom)

  // ═══════════════════════════════════════════════════════════
  // WALL THICKNESS HEATMAP
  // ═══════════════════════════════════════════════════════════
  let _heatmapActive  = false;
  let _heatmapRestore = null;

  function _toggleHeatmap() {
    const geo = Viewport.getCurrentGeometry();
    if (!geo) { setMsg('Load a scan first.', 2500); return; }
    if (_heatmapActive && _heatmapRestore) {
      _heatmapRestore();
      _heatmapRestore = null;
      _heatmapActive  = false;
      _hideHeatmapLegend();
      document.getElementById('tb-heatmap')?.classList.remove('active');
      setMsg('Thickness heatmap off.');
      Viewport.render();
      return;
    }
    setMsg('Computing wall thickness…', 0);
    setTimeout(() => {
      try {
        const minT     = parseFloat(document.getElementById('ht-min-thick')?.value ?? 0.5);
        const maxT     = parseFloat(document.getElementById('ht-max-thick')?.value ?? 3.0);
        // Get selected material from the design-params select (first Material select)
        const matSel   = document.querySelector('#design-step-inner .form-select');
        const material = matSel?.value || 'Zirconia (3Y-TZP)';
        // Let material drive thresholds if user hasn't overridden them
        const thresh   = WallThickness.getThresholds(material);
        const effectiveMin = minT !== 0.5 ? minT : thresh.minThick;
        const effectiveMax = maxT !== 3.0 ? maxT : thresh.maxThick;
        const { colorAttr, stats, thresholds } = WallThickness.compute(geo, {
          minThick: effectiveMin, maxThick: effectiveMax, sampleStep: 2, material
        });
        geo.setAttribute('color', colorAttr);
        const mat = Viewport.getMeshMaterial?.();
        if (mat) { mat.vertexColors = true; mat.needsUpdate = true; }
        _heatmapActive  = true;
        _heatmapRestore = () => {
          geo.deleteAttribute('color');
          const m = Viewport.getMeshMaterial?.();
          if (m) { m.vertexColors = false; m.needsUpdate = true; }
        };
        _showHeatmapLegend(stats, effectiveMin, effectiveMax, thresholds?.label);
        document.getElementById('tb-heatmap')?.classList.add('active');
        // ── Feed real thickness result into wizard caseData ───
        Wizard.getData().thicknessCheck = {
          pass:  stats.pctBelowMin === 0,
          min:   stats.min,
          mean:  stats.mean,
          label: thresholds?.label || material,
        };
        setMsg(`Heatmap [${thresholds?.label}]: min ${stats.min} mm  avg ${stats.mean} mm  (${stats.pctBelowMin}% below limit)`);
        Viewport.render();
      } catch (err) {
        if (typeof Logger !== 'undefined') Logger.error('Heatmap', err);
        setMsg(`Heatmap error: ${err.message}`, 4000);
      }
    }, 0);
  }

  function _showHeatmapLegend(stats, minT, maxT, matLabel = '') {
    let leg = document.getElementById('heatmap-legend');
    if (!leg) {
      leg = document.createElement('div');
      leg.id = 'heatmap-legend';
      Object.assign(leg.style, {
        position:'absolute', bottom:'36px', right:'12px',
        background:'rgba(20,20,24,.9)', border:'1px solid #3c3c3c',
        borderRadius:'6px', padding:'10px 14px', zIndex:'20',
        fontFamily:'Segoe UI,sans-serif', fontSize:'11px', color:'#ccc',
        minWidth:'190px', lineHeight:'1.6',
      });
      document.getElementById('viewport-container')?.appendChild(leg);
    }
    const pctOk = +(100 - stats.pctBelowMin).toFixed(1);
    leg.innerHTML = `
      <div style="font-weight:bold;color:#9cdcfe;margin-bottom:6px">
        Wall Thickness${matLabel ? ` — ${matLabel}` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <div style="width:80px;height:10px;border-radius:4px;
          background:linear-gradient(to right,#f14c4c,#e8c065,#4ec9b0)"></div>
        <span>${minT}→${maxT} mm</span>
      </div>
      <div>Min: <b style="color:${stats.min<minT?'#f14c4c':'#4ec9b0'}">${stats.min} mm</b></div>
      <div>Avg: <b>${stats.mean} mm</b></div>
      <div>Max: <b>${stats.max} mm</b></div>
      <div>OK:  <b style="color:${pctOk>=95?'#4ec9b0':'#e8c065'}">${pctOk}%</b></div>
      <div style="margin-top:5px;font-size:10px;color:${stats.pctBelowMin>0?'#f14c4c':'#4ec9b0'}">
        ${stats.pctBelowMin>0 ? `⚠ ${stats.pctBelowMin}% below ${minT} mm` : '✔ All within limits'}
      </div>
      <div style="margin-top:6px;font-size:9px;color:#555;border-top:1px solid #333;padding-top:4px;line-height:1.4">
        ⚠ Visual aid only — not clinical approval
      </div>`;
    leg.style.display = 'block';
  }

  function _hideHeatmapLegend() {
    const el = document.getElementById('heatmap-legend');
    if (el) el.style.display = 'none';
  }

  document.getElementById('tb-heatmap')?.addEventListener('click', _toggleHeatmap);
  ['ht-min-thick','ht-max-thick'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      if (_heatmapActive) { if (_heatmapRestore) _heatmapRestore(); _heatmapActive = false; _toggleHeatmap(); }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // AUTO MARGIN LINE DETECTION
  // ═══════════════════════════════════════════════════════════
  document.getElementById('btn-auto-margin')?.addEventListener('click', () => {
    const geo = Viewport.getCurrentGeometry();
    if (!geo) { setMsg('Load a scan first.', 2500); return; }

    // Show AUTO-SUGGEST disclaimer BEFORE running
    const warningBanner = document.getElementById('margin-auto-suggest-banner');
    if (warningBanner) warningBanner.classList.remove('hidden');

    setMsg('Detecting margin line (Auto-Suggest)…', 0);
    setTimeout(() => {
      try {
        const sensitivity = parseFloat(document.getElementById('ml-auto-sensitivity')?.value ?? 15);
        const { points, disclaimer } = MarginDetector.detectWithMeta(geo, { topPct: sensitivity, smoothIter: 4 });
        if (!points.length) { setMsg('Could not detect margin — try manual placement.', 4000); return; }

        // Clear both engines
        Tools.MarginLineTool.clear();
        _marginEngine?.clear();
        Tools.MarginLineTool.invalidateCurvatureCache?.();

        // Restore into both
        points.forEach(pt => {
          Tools.MarginLineTool._restorePoint(pt);
          _marginEngine?.addMarginPoint(pt);
        });
        Tools.MarginLineTool._restoreClose(true);
        Viewport.render();
        setMsg(`⚠ Auto-Suggest: ${points.length} margin points — MUST review manually before use.`);
      } catch (err) {
        if (typeof Logger !== 'undefined') Logger.error('AutoMargin', err);
        setMsg(`Margin error: ${err.message}`, 4000);
      }
    }, 0);
  });

  // ═══════════════════════════════════════════════════════════
  // ARTICULATOR — declaration only; UI wiring is in §4.4 below
  // ═══════════════════════════════════════════════════════════
  let _articulator = null;

  function _initArticulator() {
    const scene = Viewport.getScene?.();
    if (!scene) { setMsg('Viewport not ready.', 2000); return; }
    if (_articulator) { _articulator.dispose(); _articulator = null; }
    _articulator = Articulator.create(null, null, scene, {
      condylarInclination: parseFloat(document.getElementById('art-cond-inc')?.value ?? 30),
      bennetAngle:         parseFloat(document.getElementById('art-bennett')?.value  ?? 15),
    });
    setMsg('Articulator initialised.', 1500);
  }

  // ═══════════════════════════════════════════════════════════
  // REAL VALIDATION
  // ═══════════════════════════════════════════════════════════
  function _runValidation() {
    const geo = Viewport.getCurrentGeometry();
    const matSel   = document.querySelector('#props-panel .form-select');
    const material = matSel?.value || 'Zirconia (3Y-TZP)';
    const thresh   = WallThickness.getThresholds(material);
    const results  = Validator.runAllMeshes(Viewport.getCurrentMesh?.(), _opposingMesh, {
      material,
      minThickness: thresh.minThick,
      maxThickness: thresh.maxThick,
    });

    // ── Derive contactOk: pass if no contact-related check failed ──
    const contactResult = results.find(r => r.id && r.id.includes('contact'));
    const thickResult   = results.find(r => r.id && r.id.includes('thick'));
    Wizard.getData().validationResults = {
      contactOk: contactResult ? contactResult.pass : false,
      thicknessOk: thickResult ? thickResult.pass : false,
      allPassed: results.filter(r => !r.isDisclaimer).every(r => r.pass),
    };
    // Also update thicknessCheck for chk-thick
    if (thickResult) {
      Wizard.getData().thicknessCheck = {
        pass:  thickResult.pass,
        min:   thickResult.value,
        label: material,
      };
    }

    results.forEach(r => {
      if (r.isDisclaimer) return;
      const candidates = [
        `chk-${r.id}`,
        `chk-${r.id.replace(/_ok$/, '')}`,
        `chk-${r.id.replace(/_/g,'-').replace(/-ok$/,'')}`,
      ];
      let el = null;
      for (const c of candidates) { el = document.getElementById(c); if (el) break; }
      if (!el) return;
      const icon  = r.pass ? '✅' : '⚠';
      const color = r.pass ? 'var(--green)' : 'var(--yellow)';
      el.innerHTML = `<span class="check-icon">${icon}</span>
        <span style="color:${color}">${r.label}</span>
        <span style="color:#555;font-size:10px;margin-left:6px">${r.message}</span>`;
    });
    const failed = results.filter(r => !r.pass && !r.isDisclaimer).length;
    setMsg(failed
      ? `${failed} validation check(s) failed — review required before manufacturing.`
      : `All checks passed (${material}) — review still required before clinical use.`,
      5000
    );
  }

  // Hook into wizard step 6 (Review & Export)
  const _origOnStep = Wizard.getData; // dummy to ensure wizard is loaded
  document.getElementById('btn-next')?.addEventListener('click', () => {
    if (Wizard.getStep() === 5) setTimeout(_runValidation, 200); // step 5→6
  });

  // ═══════════════════════════════════════════════════════════
  // TOOTH LIBRARY — double-click handler replaced by §4.3 below
  // ═══════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════
  // OCCLUSION HEATMAP TOGGLE
  // ═══════════════════════════════════════════════════════════
  function _toggleOcclusionHeatmap() {
    const mesh = Viewport.getCurrentMesh?.();
    if (!mesh) { setMsg('Load a scan first.', 2500); return; }
    _initEngines();

    if (_occlusionActive) {
      _occlusionEngine.restoreOriginalMaterial(mesh);
      _occlusionActive = false;
      document.getElementById('tb-occlusion')?.classList.remove('active');
      setMsg('Occlusion heatmap off.');
    } else {
      const opposingY = parseFloat(document.getElementById('occ-opposing-y')?.value ?? 2.5);
      _occlusionEngine.setOpposingPlane(opposingY);
      _occlusionEngine.applyToMesh(mesh, opposingY);
      _occlusionActive = true;
      document.getElementById('tb-occlusion')?.classList.add('active');
      setMsg('Occlusion heatmap on — Red=collision  Green=contact  Blue=clearance');
    }
    Viewport.render();
  }

  document.getElementById('tb-occlusion')?.addEventListener('click', _toggleOcclusionHeatmap);

  // Live opposing-plane slider
  document.getElementById('occ-opposing-y')?.addEventListener('input', function() {
    if (!_occlusionActive || !_occlusionEngine) return;
    _occlusionEngine.setOpposingPlane(parseFloat(this.value));
    Viewport.render();
  });

  // Auto-trim high spots
  document.getElementById('btn-auto-trim')?.addEventListener('click', () => {
    const mesh = Viewport.getCurrentMesh?.();
    if (!mesh) { setMsg('Load a scan first.', 2500); return; }
    _initEngines();
    const oY  = parseFloat(document.getElementById('occ-opposing-y')?.value ?? 2.5);
    const clr = parseFloat(document.getElementById('occ-clearance')?.value  ?? 0.02);
    const n   = _occlusionEngine.autoAdaptOcclusion(mesh, oY, clr);
    Viewport.render();
    setMsg(n > 0 ? `Auto-trimmed ${n} vertices above opposing plane.` : 'No vertices needed trimming.');
  });

  // ═══════════════════════════════════════════════════════════
  // CROWN GENERATOR — cement gap + crown fitting
  // ═══════════════════════════════════════════════════════════
  document.getElementById('btn-gen-cement-gap')?.addEventListener('click', () => {
    const mesh = Viewport.getCurrentMesh?.();
    if (!mesh) { setMsg('Load a scan first.', 2500); return; }
    _initEngines();

    const gapMM = parseFloat(document.getElementById('crown-cement-gap')?.value ?? 0.05);
    _crownEngine.setCementGap(gapMM);
    const shell = _crownEngine.generateCementGapShell(mesh);
    if (shell) {
      setMsg(`Cement gap shell generated: ${gapMM * 1000} µm offset`);
      Viewport.render();
    }
  });

  document.getElementById('btn-adapt-crown')?.addEventListener('click', () => {
    const mesh = Viewport.getCurrentMesh?.();
    if (!mesh) { setMsg('Load a scan first.', 2500); return; }
    const mlPts = Tools.MarginLineTool.getPoints();
    const mlPts3 = mlPts.map(([x,y,z]) => new THREE.Vector3(x,y,z));
    if (mlPts3.length < 3) {
      setMsg('⚠ Draw at least 3 margin line points first.', 3000);
      return;
    }
    _initEngines();
    _crownEngine.adaptCrownToMargin(mesh, mlPts3);
    Viewport.render();
    setMsg(`Crown adapted to margin line (${mlPts3.length} points).`);
  });

  document.getElementById('btn-dispose-cement')?.addEventListener('click', () => {
    _crownEngine?.disposeShell();
    Viewport.render();
    setMsg('Cement gap shell removed.');
  });

  // ═══════════════════════════════════════════════════════════
  // §4.1 — FOLDER WATCH (scanner simulation)
  // ═══════════════════════════════════════════════════════════
  function _openFolderWatch() { openModal('folder-watch-modal'); }

  // Populate blank-size select in nesting modal
  (function _populateBlankSizes() {
    const sel = document.getElementById('nesting-blank-size');
    if (!sel || typeof NestingPreview === 'undefined') return;
    NestingPreview.getBlankSizes().forEach((key, i) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = key;
      if (i === 0) opt.selected = true;
      sel.appendChild(opt);
    });
  })();

  function _fwSetStatus(msg) {
    const el = document.getElementById('fw-status');
    if (el) el.textContent = msg;
    setMsg(msg, 4000);
  }
  function _fwAddHistory(msg) {
    const el = document.getElementById('fw-history');
    if (!el) return;
    el.style.display = 'block';
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    el.insertBefore(line, el.firstChild);
    // Keep last 20 entries
    while (el.children.length > 20) el.removeChild(el.lastChild);
  }

  document.getElementById('btn-fw-start')?.addEventListener('click', async () => {
    const pollSel = document.getElementById('fw-poll-interval');
    const pollMs  = parseInt(pollSel?.value || '3000', 10);
    if (typeof FolderWatch !== 'undefined') {
      FolderWatch.setPollMs(pollMs);
    }
    if (typeof FolderWatch === 'undefined' || !FolderWatch.isSupported()) {
      _fwSetStatus('⚠ File System Access API not supported in this browser. Use Chrome/Edge 86+.');
      return;
    }
    const ok = await FolderWatch.start(
      async (file) => {
        _fwAddHistory(`📥 Auto-importing: ${file.name}`);
        _fwSetStatus(`Importing: ${file.name}…`);
        await _loadRealFile(file);
        _fwAddHistory(`✔ Imported: ${file.name}`);
        _fwSetStatus(`✔ Watching: ${FolderWatch.getDirName()}`);
      },
      (msg) => { _fwSetStatus(msg); _fwAddHistory(msg); }
    );
    if (ok) {
      document.getElementById('btn-fw-start').disabled = true;
      document.getElementById('btn-fw-stop').disabled  = false;
    }
  });

  document.getElementById('btn-fw-stop')?.addEventListener('click', () => {
    if (typeof FolderWatch !== 'undefined') FolderWatch.stop();
    _fwSetStatus('Stopped watching folder.');
    document.getElementById('btn-fw-start').disabled = false;
    document.getElementById('btn-fw-stop').disabled  = true;
  });

  // ═══════════════════════════════════════════════════════════
  // §2 — MANUFACTURING PANEL (Review & Export step)
  // ═══════════════════════════════════════════════════════════

  /** Render nesting canvas in the review step. */
  function _renderNestingReview() {
    const canvas = document.getElementById('nesting-canvas-review');
    if (!canvas || typeof NestingPreview === 'undefined') return;
    const geo     = Viewport.getCurrentGeometry();
    const geos    = geo ? [geo] : [];
    const blank   = document.getElementById('blank-size-select')?.value || '98 × 14 mm (Standard)';
    const pad     = parseFloat(document.getElementById('nesting-padding-review')?.value || '2');
    canvas.width  = Math.max(400, (canvas.parentElement?.clientWidth || 560) - 40);
    canvas.height = 200;
    NestingPreview.render(canvas, geos, blank, { padding: pad });
  }

  // Wire blank-size select + padding input
  document.getElementById('blank-size-select')?.addEventListener('change',  _renderNestingReview);
  document.getElementById('nesting-padding-review')?.addEventListener('input', _renderNestingReview);
  document.getElementById('btn-nesting-refresh-review')?.addEventListener('click', _renderNestingReview);

  // Auto-render when the user lands on step 7 (Review & Export)
  // Wizard.init callback already calls _scheduleAutoSave on every step change;
  // we hook onto the existing step-change path:
  const _origWizardOnStep = Wizard.init;   // init already called — patch goTo instead:
  (function _patchGoToForMfg() {
    const _orig = Wizard.goTo.bind(Wizard);
    Wizard.goTo = function (index) {
      _orig(index);
      if (index === 6) {              // step 7 = index 6
        setTimeout(_renderNestingReview, 60);
      }
    };
  })();

  // Support generation
  document.getElementById('btn-generate-supports')?.addEventListener('click', () => {
    const geo = Viewport.getCurrentGeometry();
    if (!geo) { setMsg('Load a scan first.', 2500); return; }
    if (typeof SupportGenerator === 'undefined') { setMsg('SupportGenerator not loaded.', 2000); return; }

    const statusEl = document.getElementById('supports-status');
    if (statusEl) statusEl.textContent = 'Generating supports…';
    setMsg('Generating supports… (PREVIEW ONLY)', 0);

    setTimeout(() => {
      try {
        const withSupports = SupportGenerator.generate(geo, {
          overhangAngle: 45,
          supportRadius: 0.05,
          gridSpacing:   0.6,
        });
        const cnt = withSupports.userData?.supportCount ?? 0;

        // Update viewport
        Viewport.loadGeometry(withSupports, withSupports.userData?.stats || state.meshStats);
        _initEngines();
        _retargetEngines();

        // Store in wizard data for export
        Wizard.getData().finalGeometry = withSupports;

        // Refresh nesting preview with updated geometry
        _renderNestingReview();

        const msg = cnt > 0
          ? `✔ ${cnt} support column(s) added — PREVIEW ONLY, review before manufacturing`
          : '✔ No overhangs detected — supports not needed';
        if (statusEl) { statusEl.textContent = msg; statusEl.style.color = cnt > 0 ? 'var(--yellow)' : 'var(--green)'; }
        setMsg(msg, 5000);
      } catch (err) {
        if (statusEl) { statusEl.textContent = `Error: ${err.message}`; statusEl.style.color = 'var(--red)'; }
        setMsg(`Support error: ${err.message}`, 4000);
      }
    }, 0);
  });

  // ═══════════════════════════════════════════════════════════
  // §2.3 — FOLDER WATCH button in Scan Import step
  // ═══════════════════════════════════════════════════════════
  document.getElementById('btn-folder-watch-scan')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('fw-scan-status');

    if (typeof FolderWatch === 'undefined') {
      if (statusEl) statusEl.textContent = '⚠ FolderWatch module not loaded.';
      return;
    }

    // Show browser-support warning immediately for unsupported browsers
    if (!FolderWatch.isSupported()) {
      if (statusEl) {
        statusEl.textContent = '⚠ Folder Watch requires Chrome or Edge 86+. '
          + 'This browser does not support the File System Access API.';
        statusEl.style.color = 'var(--yellow)';
      }
      return;
    }

    // If already watching, stop
    if (FolderWatch.isActive()) {
      FolderWatch.stop();
      const btn = document.getElementById('btn-folder-watch-scan');
      if (btn) { btn.textContent = '📡 Watch Folder'; btn.style.borderColor = 'rgba(6,182,212,0.3)'; }
      if (statusEl) { statusEl.textContent = 'Folder watch stopped.'; statusEl.style.color = 'var(--text-dim)'; }
      return;
    }

    const ok = await FolderWatch.start(
      async (file) => {
        // Auto-import: reuse the existing scan-load pipeline
        if (statusEl) { statusEl.textContent = `📥 Auto-importing: ${file.name}…`; statusEl.style.color = 'var(--cyan)'; }
        await _loadRealFile(file);
        if (statusEl) { statusEl.textContent = `✔ Imported: ${file.name}`; statusEl.style.color = 'var(--green)'; }
      },
      (msg) => {
        if (statusEl) { statusEl.textContent = msg; statusEl.style.color = 'var(--cyan)'; }
      }
    );

    if (ok) {
      const btn = document.getElementById('btn-folder-watch-scan');
      if (btn) {
        btn.textContent   = '⏹ Stop Watch';
        btn.style.borderColor = 'rgba(239,68,68,0.4)';
        btn.style.color   = 'var(--red)';
      }
    }
  });

  // ═══════════════════════════════════════════════════════════
  // §4.2 — NESTING PREVIEW + Export STL with supports
  // ═══════════════════════════════════════════════════════════
  function _renderNesting() {
    const canvas = document.getElementById('nesting-canvas');
    if (!canvas || typeof NestingPreview === 'undefined') return;

    const geo    = Viewport.getCurrentGeometry();
    const geos   = geo ? [geo] : [];
    const blank  = document.getElementById('nesting-blank-size')?.value || '98 × 14 mm (Standard)';
    const pad    = parseFloat(document.getElementById('nesting-padding')?.value || '2');

    // Scale the canvas to container width
    const container = canvas.parentElement;
    canvas.width  = Math.max(400, container.clientWidth - 40);
    canvas.height = 220;

    NestingPreview.render(canvas, geos, blank, { padding: pad });

    const info = document.getElementById('nesting-info');
    if (info) {
      if (!geo) {
        info.textContent = 'Load a scan first to preview nesting.';
      } else {
        const pos = geo.getAttribute('position');
        info.textContent = `1 restoration  |  ${(pos?.count / 3 | 0).toLocaleString()} triangles  |  Blank: ${blank}`;
      }
    }
  }

  document.getElementById('tb-nesting')?.addEventListener('click', () => {
    openModal('nesting-modal');
    setTimeout(_renderNesting, 80);
  });
  document.getElementById('btn-nesting-refresh')?.addEventListener('click', _renderNesting);
  document.getElementById('nesting-blank-size')?.addEventListener('change', _renderNesting);
  document.getElementById('nesting-padding')?.addEventListener('change', _renderNesting);

  document.getElementById('btn-nesting-add-support')?.addEventListener('click', () => {
    const geo = Viewport.getCurrentGeometry();
    if (!geo) { setMsg('Load a scan first.', 2500); return; }
    if (typeof SupportGenerator === 'undefined') { setMsg('SupportGenerator not loaded.', 2500); return; }
    setMsg('Generating supports… (preview only)', 0);
    setTimeout(() => {
      try {
        const withSupports = SupportGenerator.generate(geo, { overhangAngle: 45, supportRadius: 0.05, gridSpacing: 0.6 });
        const cnt = withSupports.userData?.supportCount ?? 0;
        Viewport.loadGeometry(withSupports, withSupports.userData?.stats || state.meshStats);
        _initEngines(); _retargetEngines();
        _renderNesting();
        setMsg(`⚠ ${cnt} preview supports added (NOT for manufacturing — visual only)`);
      } catch (err) {
        setMsg(`Support error: ${err.message}`, 4000);
      }
    }, 0);
  });

  document.getElementById('btn-nesting-export-stl')?.addEventListener('click', () => {
    const geo = Viewport.getCurrentGeometry();
    if (!geo) { setMsg('Load a scan first.', 2500); return; }
    const data = Wizard.getData();
    try {
      const filename = ProjectIO.exportMesh(geo, 'STL Binary', data.caseId + '_nested', { units: 'mm' });
      setMsg(`Exported (with supports if added): ${filename}`);
    } catch (err) {
      setMsg(`Export error: ${err.message}`, 4000);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // §4.3 — TOOTH LIBRARY: wire library card selection → real 3D model
  // ═══════════════════════════════════════════════════════════
  // Map library card data-type to ToothLibrary type codes
  const _toothTypeMap = {
    'Central Incisor':  'I',
    'Lateral Incisor':  'I',
    'Canine':           'C',
    '1st Premolar':     'P',
    '2nd Premolar':     'P',
    '1st Molar':        'M',
    '2nd Molar':        'M',
    '3rd Molar':        'M',
    'Implant Crown':    'I',  // simplified — use incisor shape
    'Veneer':           'I',
    'Inlay':            'P',
    'Onlay':            'P',
  };

  // Single-click → select + show detail
  // Double-click → load parametric 3D model into viewport
  document.querySelectorAll('#lib-step-grid .lib-card').forEach(card => {
    card.addEventListener('click', function () {
      document.querySelectorAll('#lib-step-grid .lib-card').forEach(c => c.classList.remove('selected'));
      this.classList.add('selected');
      document.getElementById('lib-detail-name').textContent  = this.dataset.lib   || '—';
      document.getElementById('lib-detail-mfr').textContent   = this.dataset.mfr   || '—';
      document.getElementById('lib-detail-type').textContent  = this.dataset.type  || '—';
      document.getElementById('lib-detail-shade').textContent = this.dataset.shade || '—';
      // Single-click already loads the 3D shape so the user sees it immediately
      _loadLibraryShape(this);
    });

    card.addEventListener('dblclick', function () {
      // dblclick also loads (double-clicking after single-click reloads cleanly)
      _loadLibraryShape(this);
    });
  });

  /**
   * Core ToothLibrary loader — called by both single-click and dblclick.
   * Generates the parametric geometry, pushes it into the viewport,
   * and stores it in caseData.finalGeometry so Design Tools can edit it.
   */
  function _loadLibraryShape(card) {
    if (typeof ToothLibrary === 'undefined') {
      setMsg('ToothLibrary not loaded.', 2000);
      return;
    }
    const toothType = _toothTypeMap[card.dataset.type] || 'I';
    const libName   = card.dataset.lib || toothType;

    // Derive FDI number from selected teeth for a proper scale hint
    const selectedTeeth = Wizard.getData().selectedTeeth || [];
    const fdis = selectedTeeth.filter(n => {
      const t = ToothLibrary.typeFromFDI(n);
      return t === toothType;
    });
    // Use scale 0.9 for lower arch teeth (FDI 3x / 4x)
    const isLower = fdis.some(n => n >= 31);
    const scale   = isLower ? 0.9 : 1.0;

    try {
      const geo = ToothLibrary.generate(toothType, { scale });
      const cnt = geo.getAttribute('position').count;
      geo.userData.stats = {
        vertices:    cnt,
        triangles:   Math.floor(cnt / 3),
        dimensions:  { x: '12.0', y: '22.0', z: '10.0' },
        rawSize:     0,
        fromLibrary: true,
        libraryName: libName,
      };

      // Push into viewport
      Viewport.loadGeometry(geo, geo.userData.stats);
      state.meshStats = geo.userData.stats;

      // ── Store geometry in caseData so Design Tools can edit it ──
      Wizard.getData().finalGeometry = geo;
      Wizard.getData().libraryItem   = libName;

      UndoRedo.clear();
      ProjectIO.markDirty();
      _scheduleAutoSave();
      _initEngines();
      _retargetEngines();

      document.getElementById('margin-auto-suggest-banner')?.classList.add('hidden');

      // Show a hint tooltip on the lib-detail panel
      const hintEl = document.getElementById('lib-load-hint');
      if (hintEl) {
        hintEl.textContent = `✔ Loaded in viewport — go to Design Tools to sculpt`;
        hintEl.style.color = 'var(--green)';
      }
      setMsg(`Library: ${libName} (${toothType}${isLower ? ' lower' : ''}) — ${Math.floor(cnt/3).toLocaleString()} triangles`);
    } catch (err) {
      if (typeof Logger !== 'undefined') Logger.error('ToothLib', err);
      setMsg(`Library error: ${err.message}`, 3000);
    }
  }

  // Right-dock thumbs: single-click loads the shape immediately
  document.querySelectorAll('.lib-thumb').forEach(thumb => {
    thumb.addEventListener('click', function () {
      document.querySelectorAll('.lib-thumb').forEach(t => t.classList.remove('selected'));
      this.classList.add('selected');
      const shapeName = this.dataset.shape;

      if (typeof ToothLibrary === 'undefined') { setMsg(`Shape: ${shapeName}`); return; }
      const toothType = _toothTypeMap[shapeName] || 'I';

      // Build a synthetic card-like object so _loadLibraryShape can reuse it
      _loadLibraryShape({ dataset: { type: shapeName, lib: shapeName } });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // §4.4 — VIRTUAL ARTICULATOR: full UI wiring
  //   • Load Opposing Arch (file picker → STL parsed as transparent mesh)
  //   • Bite Simulation slider (0–100) → Articulator.animate()
  //   • Contact points: vertex-colour heatmap when arches are close
  // ═══════════════════════════════════════════════════════════

  let _contactPointMarkers = [];
  let _opposingMesh        = null;   // THREE.Mesh for the opposing arch
  const CONTACT_THRESH     = 0.12;   // scene units (~mm)

  function _clearContactMarkers() {
    const scene = Viewport.getScene?.();
    if (scene) _contactPointMarkers.forEach(m => scene.remove(m));
    _contactPointMarkers = [];
  }

  // ── Opposing arch loader ──────────────────────────────────
  document.getElementById('btn-load-opposing')?.addEventListener('click', () => {
    document.getElementById('opposing-file-input')?.click();
  });

  document.getElementById('opposing-file-input')?.addEventListener('change', async function () {
    const file = this.files?.[0];
    if (!file) return;
    const statusEl = document.getElementById('opposing-status');
    if (statusEl) { statusEl.textContent = `Loading ${file.name}…`; statusEl.style.color = 'var(--accent-dim)'; }
    try {
      const scene = Viewport.getScene?.();
      if (!scene) throw new Error('Viewport not ready');

      const { geometry } = await STLParser.parseFile(file);

      // Remove previous opposing mesh
      if (_opposingMesh) { scene.remove(_opposingMesh); _opposingMesh = null; }

      // Semi-transparent purple material to distinguish from restoration
      const mat = new THREE.MeshPhongMaterial({
        color:       0x8b5cf6,
        transparent: true,
        opacity:     0.35,
        side:        THREE.DoubleSide,
        depthWrite:  false,
      });
      _opposingMesh = new THREE.Mesh(geometry, mat);
      // Offset upward so it starts above the current model
      _opposingMesh.position.y = 3.5;
      scene.add(_opposingMesh);
      Viewport.render?.();

      if (statusEl) { statusEl.textContent = `✔ ${file.name} loaded as opposing arch`; statusEl.style.color = 'var(--green)'; }
      setMsg(`Opposing arch loaded: ${file.name} — adjust Bite Simulation slider`);
    } catch (err) {
      if (statusEl) { statusEl.textContent = `⚠ ${err.message}`; statusEl.style.color = 'var(--red)'; }
    }
    this.value = '';
  });

  // ── Contact point detection + colour heatmap ──────────────
  function _showContactPoints() {
    _clearContactMarkers();
    const scene = Viewport.getScene?.();
    const mesh  = Viewport.getCurrentMesh?.();
    if (!scene || !mesh) return;

    const pos    = mesh.geometry.getAttribute('position');
    const colors = mesh.geometry.getAttribute('color');
    _initEngines();

    // Build colour attribute if not present
    let colorAttr = colors;
    if (!colorAttr || colorAttr.count !== pos.count) {
      colorAttr = new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(0.87), 3);
      mesh.geometry.setAttribute('color', colorAttr);
      const mat = Viewport.getMeshMaterial?.();
      if (mat) { mat.vertexColors = true; mat.needsUpdate = true; }
    }

    const meshReport = _opposingMesh && _occlusionEngine
      ? _occlusionEngine.analyzeMeshOcclusion(mesh, _opposingMesh, {
          contactMM: CONTACT_THRESH,
          clearanceMM: parseFloat(document.getElementById('occ-clearance')?.value ?? 0.02),
        }) : null;
    const oppY = _opposingMesh
      ? ((_opposingMesh.geometry.boundingBox || _opposingMesh.geometry.computeBoundingBox(), _opposingMesh.position.y + (_opposingMesh.geometry.boundingBox?.min?.y ?? 0)))
      : parseFloat(document.getElementById('occ-opposing-y')?.value ?? 2.5);

    let contactCount = 0;
    const grid = new Map();

    for (let i = 0; i < pos.count; i++) {
      const worldPoint = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
      const wy   = worldPoint.y;
      const dist = meshReport ? meshReport.distances[i] : Math.abs(wy - oppY);

      if (dist < CONTACT_THRESH) {
        // Colour vertex: red = collision, orange = near contact
        const t = 1 - dist / CONTACT_THRESH;  // 0–1, 1=full contact
        colorAttr.setXYZ(i, 1, 1 - t * 0.85, 0);  // red→orange

        // Grid-deduplicate for marker spheres
        const gx = (pos.getX(i) * 4 | 0), gz = (pos.getZ(i) * 4 | 0);
        const key = `${gx}_${gz}`;
        if (!grid.has(key)) {
          grid.set(key, new THREE.Vector3(
            worldPoint.x, worldPoint.y, worldPoint.z
          ));
        }
        contactCount++;
      } else {
        colorAttr.setXYZ(i, 0.87, 0.83, 0.76);  // restore ivory
      }
    }
    colorAttr.needsUpdate = true;

    // Marker spheres at unique contact grid cells
    const mGeo = new THREE.SphereGeometry(0.055, 6, 6);
    const mMat = new THREE.MeshBasicMaterial({ color: 0xff4400, depthTest: false });
    for (const [, pt] of grid) {
      const m = new THREE.Mesh(mGeo, mMat.clone());
      m.position.copy(pt);
      m.renderOrder = 999;
      scene.add(m);
      _contactPointMarkers.push(m);
    }

    // Update info box
    const infoEl = document.getElementById('art-contact-info');
    if (infoEl) {
      if (grid.size > 0) {
        infoEl.innerHTML =
          `<span style="color:#ff6633">⚑</span> <b>${grid.size}</b> contact point(s) detected` +
          ` — <span style="font-size:9.5px;color:#888">${contactCount} vertices within ${CONTACT_THRESH} mm threshold</span>`;
      } else {
        infoEl.textContent = `✔ No contacts detected at current position`;
        infoEl.style.color = 'var(--green)';
      }
    }

    Viewport.render?.();
    return grid.size;
  }

  function _clearContactColours() {
    const mesh = Viewport.getCurrentMesh?.();
    if (!mesh) return;
    const pos   = mesh.geometry.getAttribute('position');
    const color = mesh.geometry.getAttribute('color');
    if (color) {
      for (let i = 0; i < pos.count; i++) color.setXYZ(i, 0.87, 0.83, 0.76);
      color.needsUpdate = true;
    }
    _clearContactMarkers();
    const infoEl = document.getElementById('art-contact-info');
    if (infoEl) { infoEl.textContent = 'Contact points: — (init articulator first)'; infoEl.style.color = 'var(--text-dim)'; }
  }

  // ── Simulate Bite button ──────────────────────────────────
  document.getElementById('btn-art-init')?.addEventListener('click', () => {
    _initArticulator();
    _showContactPoints();
  });

  // ── Excursion slider — live update ────────────────────────
  const _artSliderEl = document.getElementById('art-excursion');
  if (_artSliderEl) {
    // Clone to remove previous (duplicate) listener added by old code path
    const newSlider = _artSliderEl.cloneNode(true);
    _artSliderEl.parentNode.replaceChild(newSlider, _artSliderEl);

    newSlider.addEventListener('input', function () {
      const t    = parseFloat(this.value);
      const valEl = document.getElementById('art-excursion-val');
      if (valEl) valEl.textContent = `${Math.round(t * 100)}%`;

      if (!_articulator) _initArticulator();
      const mode = document.querySelector('.art-mode-btn.active')?.dataset.mode ?? 'protrusive';
      _articulator?.animate(mode, t);

      // Move opposing mesh proportionally if loaded
      if (_opposingMesh) {
        _opposingMesh.position.y = 3.5 - t * 3.5;  // descend toward restoration
      }

      _showContactPoints();
      Viewport.render?.();
    });
  }

  // ── Mode buttons ──────────────────────────────────────────
  document.querySelectorAll('.art-mode-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.art-mode-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      if (!_articulator) _initArticulator();
      const t = parseFloat(document.getElementById('art-excursion')?.value ?? 0);
      _articulator?.animate(this.dataset.mode, t);
      _showContactPoints();
      Viewport.render?.();
    });
  });

  // ── Reset ─────────────────────────────────────────────────
  document.getElementById('btn-art-reset')?.addEventListener('click', () => {
    _articulator?.reset();
    const sl = document.getElementById('art-excursion');
    if (sl) { sl.value = 0; }
    const valEl = document.getElementById('art-excursion-val');
    if (valEl) valEl.textContent = '0%';
    if (_opposingMesh) _opposingMesh.position.y = 3.5;
    _clearContactColours();
    Viewport.render?.();
    setMsg('Articulator reset to ICP.');
  });

  // ═══════════════════════════════════════════════════════════
  // §4.5 — UNDO/REDO: extend to cover wizard step changes
  // ═══════════════════════════════════════════════════════════
  /**
   * Wrap Wizard.goTo() so every manual step navigation is undoable.
   * Also wraps restoration-type selection and library selection.
   */
  (function _patchWizardForUndo() {
    const _origGoTo = Wizard.goTo.bind(Wizard);

    // Override goTo to push a WizardStepCommand
    Wizard.goTo = function (index) {
      const prevStep = Wizard.getStep();
      if (index === prevStep) { _origGoTo(index); return; }
      UndoRedo.push({
        label:   `Navigate to Step ${index + 1}: ${['New Case','Scan','Teeth','Restoration','Design','Library','Review'][index] || 'Step'}`,
        execute: () => { _origGoTo(index); },
        undo:    () => { _origGoTo(prevStep); },
      });
    };

    // Restoration card selection → undo
    document.querySelectorAll('.rest-card').forEach(card => {
      card.addEventListener('click', function () {
        const prev = document.querySelector('.rest-card.selected')?.dataset.rest || null;
        const next = this.dataset.rest;
        if (prev === next) return;

        document.querySelectorAll('.rest-card').forEach(c => c.classList.remove('selected'));
        this.classList.add('selected');
        document.getElementById('rest-selection-label').textContent = `Selected: ${next}`;

        UndoRedo.push({
          label:   `Restoration type: ${next}`,
          execute: () => {
            document.querySelectorAll('.rest-card').forEach(c => c.classList.toggle('selected', c.dataset.rest === next));
            document.getElementById('rest-selection-label').textContent = `Selected: ${next}`;
          },
          undo: () => {
            const prevCard = prev
              ? document.querySelector(`.rest-card[data-rest="${prev}"]`)
              : null;
            document.querySelectorAll('.rest-card').forEach(c => c.classList.remove('selected'));
            if (prevCard) { prevCard.classList.add('selected'); }
            document.getElementById('rest-selection-label').textContent =
              prev ? `Selected: ${prev}` : 'No restoration type selected.';
          },
        });
      });
    });
  })();

  // ═══════════════════════════════════════════════════════════
  // §5 — UX POLISH
  // ═══════════════════════════════════════════════════════════

  // ── 5.1 Keyboard shortcuts ────────────────────────────────
  // Space + 1-7 already merged into main keydown handler above.
  // Update shortcuts modal to include new shortcuts:
  (function _updateShortcutsModal() {
    const modal = document.querySelector('#shortcuts-modal .modal-body > div');
    if (!modal) return;
    const extra = document.createElement('div');
    extra.style.cssText = 'grid-column:1/-1;height:1px;background:var(--border);margin:4px 0';
    modal.appendChild(extra);
    [
      ['Space', 'Toggle Expert / Wizard mode'],
      ['1 – 7', 'Jump to Wizard Step (Wizard mode)'],
      ['Ctrl+Y', 'Redo'],
      ['M', 'Activate Margin Line tool'],
      ['D', 'Activate Measure tool'],
      ['X', 'Activate Section Cut tool'],
    ].forEach(([key, desc]) => {
      const k = document.createElement('span');
      k.style.cssText = 'color:#007acc;font-family:monospace';
      k.textContent = key;
      const d = document.createElement('span');
      d.textContent = desc;
      modal.appendChild(k);
      modal.appendChild(d);
    });
  })();

  // ── 5.2 Auto-save indicator — red dot / green dot ─────────
  ProjectIO.onDirtyChange((dirty) => {
    const ind = document.getElementById('unsaved-indicator');
    if (!ind) return;
    if (dirty) {
      ind.classList.remove('hidden');
      ind.style.color = 'var(--yellow)';
      ind.title = 'Unsaved changes — Ctrl+S to save';
    } else {
      // Show green briefly then hide
      ind.classList.remove('hidden');
      ind.style.color = 'var(--green)';
      ind.textContent = '● Saved';
      ind.title = 'All changes saved';
      setTimeout(() => {
        ind.classList.add('hidden');
        ind.textContent = '● Unsaved';
        ind.style.color = 'var(--yellow)';
      }, 2200);
    }
  });

  // ── 5.3 Real loading progress for large STL files ─────────
  // Override _showScanProgress to use the STLParser chunked-read
  // progress if available. STLParser fires a 'progress' event if
  // the file is parsed in chunks (binary STL only for now).
  // We hook via a global event so STLParser can fire it.
  window.addEventListener('dentalcad:parse-progress', (e) => {
    const { pct, msg } = e.detail || {};
    const fill = document.getElementById('scan-prog-fill');
    if (fill && pct !== undefined) fill.style.width = Math.min(pct, 95) + '%';
    const status = document.getElementById('scan-status');
    if (status && msg) { status.textContent = msg; }
  });

  // ── 5.4 Responsive / dock collapse on narrow screens ──────
  // ── 5.4 Responsive / drawer layout for tablet & mobile ────
  (function _initResponsive() {
    const leftDock  = document.getElementById('left-dock');
    const rightDock = document.getElementById('right-dock');
    const mainBody  = document.getElementById('main-body');

    // Create backdrop overlay
    const backdrop = document.createElement('div');
    backdrop.className = 'drawer-backdrop';
    backdrop.id = 'drawer-backdrop';
    document.getElementById('app')?.appendChild(backdrop);

    // Create drawer toggle buttons (shown only on ≤1024px via CSS)
    function _makeToggle(side) {
      const btn = document.createElement('button');
      btn.className  = `drawer-toggle ${side === 'right' ? 'right' : ''}`;
      btn.id         = `drawer-toggle-${side}`;
      btn.setAttribute('aria-label', `${side === 'left' ? 'Open Case Tree' : 'Open Properties'}`);
      btn.innerHTML  = side === 'left' ? '›' : '‹';
      btn.style.display = 'none';   // hidden until ≤1024px
      document.getElementById('app')?.appendChild(btn);
      return btn;
    }
    const leftToggle  = _makeToggle('left');
    const rightToggle = _makeToggle('right');

    function _openDrawer(dock, toggle, isLeft) {
      dock.classList.add('drawer-open');
      backdrop.classList.add('visible');
      toggle.innerHTML = isLeft ? '‹' : '›';
      toggle.setAttribute('aria-label', isLeft ? 'Close Case Tree' : 'Close Properties');
    }
    function _closeDrawer(dock, toggle, isLeft) {
      dock.classList.remove('drawer-open');
      if (!document.querySelector('.dock.drawer-open')) backdrop.classList.remove('visible');
      toggle.innerHTML = isLeft ? '›' : '‹';
      toggle.setAttribute('aria-label', isLeft ? 'Open Case Tree' : 'Open Properties');
    }

    leftToggle.addEventListener('click', () => {
      if (leftDock?.classList.contains('drawer-open')) {
        _closeDrawer(leftDock, leftToggle, true);
      } else {
        if (leftDock) _openDrawer(leftDock, leftToggle, true);
        if (rightDock?.classList.contains('drawer-open')) _closeDrawer(rightDock, rightToggle, false);
      }
    });
    rightToggle.addEventListener('click', () => {
      if (rightDock?.classList.contains('drawer-open')) {
        _closeDrawer(rightDock, rightToggle, false);
      } else {
        if (rightDock) _openDrawer(rightDock, rightToggle, false);
        if (leftDock?.classList.contains('drawer-open')) _closeDrawer(leftDock, leftToggle, true);
      }
    });
    backdrop.addEventListener('click', () => {
      if (leftDock?.classList.contains('drawer-open'))  _closeDrawer(leftDock,  leftToggle,  true);
      if (rightDock?.classList.contains('drawer-open')) _closeDrawer(rightDock, rightToggle, false);
    });

    // Also wire existing View-menu dock toggles to work with drawer system
    const origToggleLeft  = document.querySelector('.menu-entry[data-action="toggle-left"]');
    const origToggleRight = document.querySelector('.menu-entry[data-action="toggle-right"]');
    if (origToggleLeft)  origToggleLeft.addEventListener('click',  () => leftToggle.click());
    if (origToggleRight) origToggleRight.addEventListener('click', () => rightToggle.click());

    function _checkResponsive() {
      const isTablet = window.innerWidth <= 1024;
      // Show/hide toggle buttons
      leftToggle.style.display  = isTablet ? 'flex' : 'none';
      rightToggle.style.display = isTablet ? 'flex' : 'none';

      if (!isTablet) {
        // Desktop: docks always visible, close any open drawers
        leftDock?.classList.remove('drawer-open', 'hidden');
        rightDock?.classList.remove('drawer-open', 'hidden');
        backdrop.classList.remove('visible');
      } else {
        // Tablet/mobile: close drawers on resize
        if (leftDock?.classList.contains('drawer-open'))  _closeDrawer(leftDock,  leftToggle,  true);
        if (rightDock?.classList.contains('drawer-open')) _closeDrawer(rightDock, rightToggle, false);
      }

      // Mobile ≤600px: show read-only notice in viewport if not already present
      const noticeId = 'mobile-readonly-notice';
      const vpContainer = document.getElementById('viewport-container');
      if (window.innerWidth <= 600) {
        if (vpContainer && !document.getElementById(noticeId)) {
          const notice = document.createElement('div');
          notice.id = noticeId;
          notice.style.cssText = [
            'position:absolute', 'bottom:44px', 'left:50%',
            'transform:translateX(-50%)',
            'background:rgba(14,17,24,0.88)',
            'border:1px solid rgba(255,255,255,0.1)',
            'border-radius:6px', 'padding:5px 12px',
            'font-size:10px', 'color:var(--text-dim)',
            'white-space:nowrap', 'pointer-events:none', 'z-index:20',
          ].join(';');
          notice.textContent = '📱 3D editing is optimised for desktop — viewing mode on mobile';
          vpContainer.appendChild(notice);
        }
      } else {
        document.getElementById(noticeId)?.remove();
      }

      Viewport.resize?.();
    }

    window.addEventListener('resize', _checkResponsive);
    _checkResponsive();
  })();

  setMsg('DentalCAD ready — Ctrl+N: New  |  Ctrl+O: Open  |  Ctrl+S: Save  |  Space: Toggle mode', 6000);

  // ── PWA Service Worker registration ──────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' })
        .then(reg => {
          Logger?.info('PWA', `Service worker registered (scope: ${reg.scope})`);
          // Listen for updates and show a subtle banner
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            newWorker?.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New version available — show non-intrusive notice
                const banner = document.createElement('div');
                banner.style.cssText = [
                  'position:fixed', 'bottom:30px', 'left:50%',
                  'transform:translateX(-50%)',
                  'background:var(--bg-elevated)',
                  'border:1px solid var(--accent)',
                  'border-radius:var(--radius-md)',
                  'padding:8px 16px', 'font-size:12px',
                  'color:var(--text)', 'z-index:9999',
                  'display:flex', 'gap:10px', 'align-items:center',
                  'box-shadow:var(--shadow-md)',
                ].join(';');
                banner.innerHTML =
                  '<span>🔄 New version available</span>' +
                  '<button onclick="navigator.serviceWorker.controller.postMessage({type:\'SKIP_WAITING\'});location.reload()" ' +
                  'style="background:var(--accent);border:none;border-radius:4px;color:#fff;' +
                  'padding:3px 10px;cursor:pointer;font-size:11px">Update</button>' +
                  '<button onclick="this.parentElement.remove()" ' +
                  'style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:14px">✕</button>';
                document.body.appendChild(banner);
              }
            });
          });
        })
        .catch(err => Logger?.warn('PWA', `SW registration failed: ${err.message}`));
    });
  }

}); // end DOMContentLoaded

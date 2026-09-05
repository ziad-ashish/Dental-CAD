/**
 * project-io.js  — v3  (IndexedDB backend via inline Dexie.js)
 *
 * Storage layers:
 *   Primary  : IndexedDB  (via Dexie) — no 5 MB limit, handles 100 MB+ meshes
 *   Fallback : localStorage           — used only if IndexedDB unavailable
 *   Download : .dcad JSON file        — for portability / backup
 *
 * Public API (same as v2, backward-compatible):
 *   save(caseData, geometry, extraData)  → downloads .dcad
 *   load()                               → file picker → parsed project
 *   autoSave(caseData, geometry, extra)  → IndexedDB
 *   loadAutoSave()                       → from IndexedDB
 *   clearAutoSave()
 *   hasAutoSave()                        → Promise<bool>
 *   getRecentFiles()                     → Promise<entry[]>
 *   exportMesh(geo, format, caseId, opts)→ downloads mesh file
 *   markDirty / markClean / isDirty / onDirtyChange
 *   getLastSaved()
 */

const ProjectIO = (() => {

  const FORMAT_VERSION  = '3.0';
  const APP_VERSION     = '1.0.0';
  const DB_NAME         = 'DentalCAD_DB';
  const DB_VERSION      = 1;
  const LS_FALLBACK_KEY = 'dentalcad_autosave_fallback';
  const MAX_RECENT      = 12;

  // ── IndexedDB via Dexie (loaded inline) ──────────────────
  let _db = null;      // Dexie instance (lazy init)
  let _dbReady = null; // Promise

  function _getDB() {
    if (_dbReady) return _dbReady;
    _dbReady = new Promise((resolve, reject) => {
      if (typeof Dexie === 'undefined') {
        // Dexie not loaded — fall back to localStorage shim
        resolve(null);
        return;
      }
      try {
        _db = new Dexie(DB_NAME);
        _db.version(DB_VERSION).stores({
          projects: 'id, savedAt, patient, caseId',   // id = 'autosave' or UUID
          meshes:   'id, projectId, savedAt',          // mesh blobs stored separately
          recent:   'caseId, savedAt',
        });
        _db.open().then(() => resolve(_db)).catch(err => {
          console.warn('IndexedDB open failed, falling back to localStorage:', err);
          resolve(null);
        });
      } catch (e) {
        resolve(null);
      }
    });
    return _dbReady;
  }

  // ── Dirty tracking ────────────────────────────────────────
  let _isDirty   = false;
  let _lastSaved = null;
  let _onDirty   = null;

  function markDirty()          { _isDirty = true;  _onDirty?.(true);  }
  function markClean()          { _isDirty = false; _onDirty?.(false); }
  function isDirty()            { return _isDirty; }
  function onDirtyChange(fn)    { _onDirty = fn; }
  function getLastSaved()       { return _lastSaved; }

  // ── Serialise geometry ────────────────────────────────────
  function _serializeMesh(geometry) {
    if (!geometry) return null;
    const posAttr  = geometry.getAttribute('position');
    const normAttr = geometry.getAttribute('normal');
    if (!posAttr) return null;
    return {
      positions: Array.from(posAttr.array),
      normals:   normAttr ? Array.from(normAttr.array) : [],
      triangles: Math.floor(posAttr.count / 3),
      stats:     geometry.userData.stats || {},
      importOffset:    geometry.userData.importOffset    || null,
      importViewScale: geometry.userData.importViewScale || null,
      supportsAdded:   geometry.userData.supportsAdded ?? false,
      supportCount:    geometry.userData.supportCount ?? 0,
      supportStats:    geometry.userData.supportStats || null,
    };
  }

  function _deserializeMesh(snap) {
    if (!snap || !snap.positions?.length) return null;
    if (!Array.isArray(snap.positions) || snap.positions.length % 3 !== 0 || !snap.positions.every(Number.isFinite)) {
      throw new Error('Invalid mesh positions in project file');
    }
    if (snap.normals?.length && (!Array.isArray(snap.normals) || !snap.normals.every(Number.isFinite))) {
      throw new Error('Invalid mesh normals in project file');
    }
    if (!_validateSupportMetadata(snap)) throw new Error('Invalid support metadata in project file');
    const posArr = new Float32Array(snap.positions);
    const geo    = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    if (snap.normals?.length === snap.positions.length) {
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(snap.normals), 3));
    } else {
      geo.computeVertexNormals();
    }
    geo.userData.stats           = snap.stats           || {};
    geo.userData.importOffset    = snap.importOffset    || { x:0, y:0, z:0 };
    geo.userData.importViewScale = snap.importViewScale || 1;
    if (snap.supportsAdded != null) geo.userData.supportsAdded = !!snap.supportsAdded;
    if (snap.supportCount != null) geo.userData.supportCount = Number(snap.supportCount) || 0;
    if (snap.supportStats) geo.userData.supportStats = snap.supportStats;
    return geo;
  }

  function _validateImplantPlan(plan) {
    if (plan == null) return true;
    if (!Array.isArray(plan.implants) || !Array.isArray(plan.sleeves) || !Array.isArray(plan.fixationPins)) return false;
    return plan.implants.every((implant) => {
      if (!implant || typeof implant !== 'object' || typeof implant.system !== 'string') return false;
      if (![implant.diameter, implant.length].every(Number.isFinite)) return false;
      const p = implant.position || {}, r = implant.rotation || {};
      return ['x', 'y', 'z'].every(a => Number.isFinite(p[a]) && Number.isFinite(r[a]));
    });
  }

  function _validateSupportMetadata(snap) {
    if (!snap || snap.supportStats == null) return true;
    const s = snap.supportStats;
    return !!s && Number.isFinite(Number(s.candidateCells)) && Number.isFinite(Number(s.minHeight)) && Number.isFinite(Number(s.maxHeight)) && Number.isFinite(Number(s.buildPlateY)) && Number(s.candidateCells) >= 0 && Number(s.minHeight) >= 0 && Number(s.maxHeight) >= Number(s.minHeight);
  }

  // ── Build project object ──────────────────────────────────
  function _buildProject(caseData, geometry, extraData = {}) {
    if (!_validateImplantPlan(extraData.implantPlan)) throw new Error('Invalid implant plan');
    return {
      version:      FORMAT_VERSION,
      appVersion:   APP_VERSION,
      savedAt:      new Date().toISOString(),
      caseData:     { ...caseData },
      meshSnapshot: _serializeMesh(geometry),
      marginLine:   extraData.marginLine || null,
      implantPlan:  extraData.implantPlan || null,
    };
  }

  // ── Parse / restore ───────────────────────────────────────
  function _parseProject(project) {
    if (!project?.caseData || typeof project.caseData !== 'object' || Array.isArray(project.caseData)) {
      throw new Error('Missing or invalid caseData');
    }
    if (project.version != null) {
      const major = Number.parseInt(String(project.version).split('.')[0], 10);
      const supportedMajor = Number.parseInt(FORMAT_VERSION.split('.')[0], 10);
      if (!Number.isFinite(major) || major > supportedMajor) {
        throw new Error(`Unsupported project version: ${project.version}`);
      }
    }
    const geometry       = _deserializeMesh(project.meshSnapshot);
    const stats          = project.meshSnapshot?.stats || null;
    const rawMargin      = project.marginLine?.points;
    if (rawMargin != null && (!Array.isArray(rawMargin) || !rawMargin.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)))) {
      throw new Error('Invalid margin line in project file');
    }
    const marginLine     = rawMargin?.length ? rawMargin : null;
    const marginLineClosed = project.marginLine?.closed ?? false;
    const implantPlan = project.implantPlan ?? null;
    if (!_validateImplantPlan(implantPlan)) {
      throw new Error('Invalid implant plan in project file');
    }
    markClean();
    return {
      caseData: project.caseData,
      geometry,
      stats,
      marginLine,
      marginLineClosed,
      implantPlan,
      savedAt:   project.savedAt || null,
      wizardStep: project.caseData.wizardStep ?? 0,
    };
  }

  // ── Save (download .dcad) ─────────────────────────────────
  function save(caseData, geometry = null, extraData = {}) {
    const project = _buildProject(caseData, geometry, extraData);
    const json    = JSON.stringify(project, null, 2);
    const blob    = new Blob([json], { type: 'application/json' });
    const caseId  = (caseData.caseId || 'Case').replace(/[^a-z0-9_\-]/gi, '_');
    const fname   = `DentalCAD_${caseId}.dcad`;
    _triggerDownload(blob, fname);
    _lastSaved = project.savedAt;
    markClean();
    _addToRecent({ caseId: caseData.caseId, patient: caseData.patient, savedAt: project.savedAt, filename: fname });
    return project;
  }

  // Native Electron Save As. Browser builds keep using the download fallback.
  async function saveAs(caseData, geometry = null, extraData = {}) {
    const project = _buildProject(caseData, geometry, extraData);
    const json = JSON.stringify(project, null, 2);
    const safeId = (caseData.caseId || 'Case').replace(/[^a-z0-9_\-]/gi, '_');
    const api = window.dentalcadDesktop;
    if (!api?.saveProject) return save(caseData, geometry, extraData);
    const result = await api.saveProject({ defaultPath: `DentalCAD_${safeId}.dcad`, contents: json });
    if (result?.canceled) throw new Error('Save cancelled');
    _lastSaved = project.savedAt;
    markClean();
    _addToRecent({ caseId: caseData.caseId, patient: caseData.patient, savedAt: project.savedAt, filename: result.filePath || `DentalCAD_${safeId}.dcad` });
    return project;
  }

  // ── Load (file picker) ────────────────────────────────────
  function load() {
    const desktop = window.dentalcadDesktop;
    if (desktop?.openProject) {
      return desktop.openProject().then(result => {
        if (result?.canceled) throw new Error('No file selected');
        try { return _parseProject(JSON.parse(result.contents)); }
        catch (err) { throw new Error(`Invalid .dcad: ${err.message}`); }
      });
    }
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type  = 'file';
      input.accept = '.dcad,.json';
      input.addEventListener('change', () => {
        const file = input.files[0];
        if (!file) { reject(new Error('No file selected')); return; }
        _readFile(file).then(resolve).catch(reject);
      });
      input.click();
    });
  }

  function loadFile(file) { return _readFile(file); }

  function _readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = (e) => {
        try { resolve(_parseProject(JSON.parse(e.target.result))); }
        catch (err) { reject(new Error(`Invalid .dcad: ${err.message}`)); }
      };
      reader.onerror = () => reject(new Error('File read error'));
      reader.readAsText(file);
    });
  }

  // ── Auto-save (IndexedDB primary, localStorage fallback) ──
  async function autoSave(caseData, geometry = null, extraData = {}) {
    const project = _buildProject(caseData, geometry, extraData);
    try {
      const db = await _getDB();
      if (db) {
        await db.projects.put({
          id:       'autosave',
          savedAt:  project.savedAt,
          patient:  caseData.patient || '',
          caseId:   caseData.caseId  || '',
          data:     project,          // full project object
        });
        return true; // success — no localStorage needed
      }
    } catch (err) {
      console.warn('IndexedDB autoSave failed:', err.message);
    }
    // Fallback: localStorage. Keep the full payload so recovery cannot
    // silently restore a case without its mesh.
    try {
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(project));
      return true;
    } catch (err) {
      console.warn('AutoSave unavailable: could not persist the full case.', err.message);
      return false;
    }
  }

  async function loadAutoSave() {
    try {
      const db = await _getDB();
      if (db) {
        const rec = await db.projects.get('autosave');
        if (rec?.data) return _parseProject(rec.data);
      }
    } catch (err) {
      console.warn('IndexedDB loadAutoSave failed:', err.message);
    }
    // Fallback: localStorage
    try {
      const raw = localStorage.getItem(LS_FALLBACK_KEY);
      if (raw) return _parseProject(JSON.parse(raw));
    } catch (_) {}
    return null;
  }

  async function clearAutoSave() {
    try {
      const db = await _getDB();
      if (db) await db.projects.delete('autosave');
    } catch (_) {}
    localStorage.removeItem(LS_FALLBACK_KEY);
  }

  async function hasAutoSave() {
    try {
      const db = await _getDB();
      if (db) {
        const rec = await db.projects.get('autosave');
        if (rec) return true;
      }
    } catch (_) {}
    return !!localStorage.getItem(LS_FALLBACK_KEY);
  }

  // ── Recent files ──────────────────────────────────────────
  async function _addToRecent(entry) {
    try {
      const db = await _getDB();
      if (db) {
        await db.recent.put(entry);
        // Keep only MAX_RECENT
        const all = await db.recent.orderBy('savedAt').reverse().toArray();
        if (all.length > MAX_RECENT) {
          const toDelete = all.slice(MAX_RECENT).map(r => r.caseId);
          await db.recent.bulkDelete(toDelete);
        }
        return;
      }
    } catch (_) {}
    // localStorage fallback
    try {
      const key  = 'dentalcad_recent_v3';
      const list = JSON.parse(localStorage.getItem(key) || '[]')
        .filter(r => r.caseId !== entry.caseId);
      list.unshift(entry);
      localStorage.setItem(key, JSON.stringify(list.slice(0, MAX_RECENT)));
    } catch (_) {}
  }

  async function getRecentFiles() {
    try {
      const db = await _getDB();
      if (db) {
        return await db.recent.orderBy('savedAt').reverse().toArray();
      }
    } catch (_) {}
    try {
      return JSON.parse(localStorage.getItem('dentalcad_recent_v3') || '[]');
    } catch (_) { return []; }
  }

  async function clearRecentFiles() {
    try {
      const db = await _getDB();
      if (db) { await db.recent.clear(); return; }
    } catch (_) {}
    localStorage.removeItem('dentalcad_recent_v3');
  }

  // ── Export mesh (unchanged API) ───────────────────────────
  function prepareExportGeometry(geometry, worldMatrix = null) {
    if (!geometry) throw new Error('Missing geometry');
    return worldMatrix ? geometry.clone().applyMatrix4(worldMatrix) : geometry;
  }

  function exportMesh(geometry, format, caseId, opts = {}) {
    const safeId = (caseId || 'Case').replace(/[^a-z0-9_\-]/gi, '_');
    const scale  = opts.units === 'in' ? 1 / 25.4 : 1.0;
    // Export the positioned mesh, not only its local geometry. The viewport
    // keeps design transforms on the mesh so they must be baked into the
    // export copy while preserving the original geometry and import metadata.
    const exportGeometry = prepareExportGeometry(geometry, opts.worldMatrix);
    let blob, filename, blob2, filename2;

    switch (format) {
      case 'STL Binary': {
        const buf = STLParser.exportBinarySTL(exportGeometry, scale);
        blob = new Blob([buf], { type: 'application/octet-stream' });
        filename = `DentalCAD_${safeId}.stl`;
        break;
      }
      case 'STL ASCII': {
        const txt = STLParser.exportASCIISTL(exportGeometry, scale);
        blob = new Blob([txt], { type: 'text/plain' });
        filename = `DentalCAD_${safeId}_ascii.stl`;
        break;
      }
      case 'OBJ': {
        const base = `DentalCAD_${safeId}`;
        blob  = new Blob([STLParser.exportOBJ(exportGeometry, scale, base, {
          marginLinePoints: opts.includeMarginLine ? opts.marginLinePoints : [],
        })], { type: 'text/plain' });
        blob2 = new Blob([STLParser.exportMTL('default')],              { type: 'text/plain' });
        filename  = `${base}.obj`;
        filename2 = `${base}.mtl`;
        break;
      }
      case 'PLY Binary': {
        const buf = STLParser.exportBinaryPLY(exportGeometry, scale);
        blob = new Blob([buf], { type: 'application/octet-stream' });
        filename = `DentalCAD_${safeId}.ply`;
        break;
      }
      case 'PLY ASCII': {
        blob = new Blob([STLParser.exportASCIIPLY(exportGeometry, scale)], { type: 'text/plain' });
        filename = `DentalCAD_${safeId}_ascii.ply`;
        break;
      }
      case '3MF': {
        blob = new Blob([STLParser.export3MFPackage(exportGeometry, scale)], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel' });
        filename = `DentalCAD_${safeId}.3mf`;
        break;
      }
      default: {
        const buf = STLParser.exportBinarySTL(exportGeometry, scale);
        blob = new Blob([buf], { type: 'application/octet-stream' });
        filename = `DentalCAD_${safeId}.stl`;
      }
    }

    _triggerDownload(blob, filename);
    if (blob2 && filename2) setTimeout(() => _triggerDownload(blob2, filename2), 400);
    return filename;
  }

  function exportManufacturingJob(job, caseId) {
    if (typeof ManufacturingJob === 'undefined') throw new Error('Manufacturing job module not loaded');
    const safeId = (caseId || job?.caseId || 'Case').replace(/[^a-z0-9_\-]/gi, '_');
    const filename = `DentalCAD_${safeId}_manufacturing-job.json`;
    _triggerDownload(new Blob([ManufacturingJob.toJSON(job)], { type: 'application/json' }), filename);
    return filename;
  }

  function exportToolpath(path, caseId, machine = 'generic') {
    if (typeof ToolpathPlanner === 'undefined') throw new Error('Toolpath planner module not loaded');
    const safeId = (caseId || 'Case').replace(/[^a-z0-9_\-]/gi, '_');
    const filename = `DentalCAD_${safeId}_roughing.nc`;
    const code = ToolpathPlanner.toGCode(path, { machine });
    const check = ToolpathPlanner.validateGCode(code, machine);
    if (!check.valid) throw new Error(check.errors.join('; '));
    _triggerDownload(new Blob([code], { type: 'text/plain' }), filename);
    return filename;
  }

  // ── Helpers ───────────────────────────────────────────────
  function _triggerDownload(blob, filename) {
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  return {
    save, saveAs, load, loadFile,
    autoSave, loadAutoSave, clearAutoSave, hasAutoSave,
    getRecentFiles, clearRecentFiles,
    exportMesh,
    exportManufacturingJob,
    exportToolpath,
    prepareExportGeometry,
    markDirty, markClean, isDirty, onDirtyChange, getLastSaved,
  };
})();

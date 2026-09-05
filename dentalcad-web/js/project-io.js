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
    };
  }

  function _deserializeMesh(snap) {
    if (!snap || !snap.positions?.length) return null;
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
    return geo;
  }

  // ── Build project object ──────────────────────────────────
  function _buildProject(caseData, geometry, extraData = {}) {
    return {
      version:      FORMAT_VERSION,
      appVersion:   APP_VERSION,
      savedAt:      new Date().toISOString(),
      caseData:     { ...caseData },
      meshSnapshot: _serializeMesh(geometry),
      marginLine:   extraData.marginLine || null,
    };
  }

  // ── Parse / restore ───────────────────────────────────────
  function _parseProject(project) {
    if (!project?.caseData) throw new Error('Missing caseData');
    const geometry       = _deserializeMesh(project.meshSnapshot);
    const stats          = project.meshSnapshot?.stats || null;
    const marginLine     = project.marginLine?.points?.length ? project.marginLine.points : null;
    const marginLineClosed = project.marginLine?.closed ?? false;
    markClean();
    return {
      caseData: project.caseData,
      geometry,
      stats,
      marginLine,
      marginLineClosed,
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

  // ── Load (file picker) ────────────────────────────────────
  function load() {
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
        return; // success — no localStorage needed
      }
    } catch (err) {
      console.warn('IndexedDB autoSave failed:', err.message);
    }
    // Fallback: localStorage (trim mesh if too large)
    try {
      let payload = project;
      const json  = JSON.stringify(payload);
      if (json.length > 2_500_000) {
        payload = _buildProject(caseData, null, {});
      }
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(payload));
    } catch (_) {}
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
  function exportMesh(geometry, format, caseId, opts = {}) {
    const safeId = (caseId || 'Case').replace(/[^a-z0-9_\-]/gi, '_');
    const scale  = opts.units === 'in' ? 1 / 25.4 : 1.0;
    let blob, filename, blob2, filename2;

    switch (format) {
      case 'STL Binary': {
        const buf = STLParser.exportBinarySTL(geometry, scale);
        blob = new Blob([buf], { type: 'application/octet-stream' });
        filename = `DentalCAD_${safeId}.stl`;
        break;
      }
      case 'STL ASCII': {
        const txt = STLParser.exportASCIISTL(geometry, scale);
        blob = new Blob([txt], { type: 'text/plain' });
        filename = `DentalCAD_${safeId}_ascii.stl`;
        break;
      }
      case 'OBJ': {
        const base = `DentalCAD_${safeId}`;
        blob  = new Blob([STLParser.exportOBJ(geometry, scale, base)], { type: 'text/plain' });
        blob2 = new Blob([STLParser.exportMTL('default')],              { type: 'text/plain' });
        filename  = `${base}.obj`;
        filename2 = `${base}.mtl`;
        break;
      }
      case 'PLY Binary': {
        const buf = STLParser.exportBinaryPLY(geometry, scale);
        blob = new Blob([buf], { type: 'application/octet-stream' });
        filename = `DentalCAD_${safeId}.ply`;
        break;
      }
      case 'PLY ASCII': {
        blob = new Blob([STLParser.exportASCIIPLY(geometry, scale)], { type: 'text/plain' });
        filename = `DentalCAD_${safeId}_ascii.ply`;
        break;
      }
      case '3MF': {
        blob = new Blob([STLParser.export3MFModel(geometry, scale)], { type: 'application/xml' });
        filename = `DentalCAD_${safeId}.3mf`;
        break;
      }
      default: {
        const buf = STLParser.exportBinarySTL(geometry, scale);
        blob = new Blob([buf], { type: 'application/octet-stream' });
        filename = `DentalCAD_${safeId}.stl`;
      }
    }

    _triggerDownload(blob, filename);
    if (blob2 && filename2) setTimeout(() => _triggerDownload(blob2, filename2), 400);
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
    save, load, loadFile,
    autoSave, loadAutoSave, clearAutoSave, hasAutoSave,
    getRecentFiles, clearRecentFiles,
    exportMesh,
    markDirty, markClean, isDirty, onDirtyChange, getLastSaved,
  };
})();

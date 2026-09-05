/**
 * manufacturing.js — Manufacturing pipeline helpers for DentalCAD
 *
 * Modules:
 *  FolderWatch   — Simulates scanner folder-watch import (File System Access API)
 *                  Watches a local directory; auto-imports new STL/OBJ files.
 *  NestingPreview — Places multiple restorations on a virtual milling blank
 *                   and renders a top-down 2D preview in a canvas.
 *  SupportGenerator — Adds simple vertical support columns under overhanging
 *                     geometry (naive implementation — educational/preview only).
 *
 * NOTE: FolderWatch requires a browser that supports the File System Access API
 *       (Chrome 86+, Edge 86+). Falls back gracefully on unsupported browsers.
 *
 * NOTE: SupportGenerator output is intended as a visual approximation only.
 *       Do NOT use for actual manufacturing without review by a qualified
 *       CAM engineer or dental technician.
 */

// ═══════════════════════════════════════════════════════════
// 1. FOLDER WATCH — simulated scanner integration
// ═══════════════════════════════════════════════════════════
const FolderWatch = (() => {

  let _dirHandle   = null;   // FileSystemDirectoryHandle
  let _knownFiles  = new Set();
  let _intervalId  = null;
  let _onNewFile   = null;   // callback(File)
  let _pollMs      = 3000;   // polling interval in ms
  let _active      = false;

  /**
   * Open a folder-picker dialog and start watching the selected folder.
   * When a new .stl or .obj file appears, calls onNewFile(File).
   *
   * @param {Function} onNewFile   — callback(File) when a new file is detected
   * @param {Function} onStatus    — callback(string) for status messages
   */
  async function start(onNewFile, onStatus) {
    if (!window.showDirectoryPicker) {
      onStatus?.('⚠ Folder Watch is not supported in this browser. Use Chrome or Edge 86+.');
      return false;
    }
    if (_active) { stop(); }

    try {
      _dirHandle  = await window.showDirectoryPicker({ mode: 'read' });
      _onNewFile  = onNewFile;
      _knownFiles = new Set();
      _active     = true;

      // Seed known files (don't import existing ones on first scan)
      for await (const [name] of _dirHandle.entries()) {
        if (_isSupported(name)) _knownFiles.add(name);
      }

      onStatus?.(`📡 Watching: ${_dirHandle.name} — polling every ${_pollMs / 1000}s`);

      _intervalId = setInterval(() => _poll(onStatus), _pollMs);
      return true;
    } catch (err) {
      if (err.name === 'AbortError') {
        onStatus?.('Folder watch cancelled.');
      } else {
        onStatus?.(`⚠ Folder watch error: ${err.message}`);
      }
      return false;
    }
  }

  async function _poll(onStatus) {
    if (!_dirHandle || !_active) return;
    try {
      const currentFiles = new Set();
      for await (const [name] of _dirHandle.entries()) {
        if (_isSupported(name)) currentFiles.add(name);
      }

      // Detect new files
      for (const name of currentFiles) {
        if (!_knownFiles.has(name)) {
          _knownFiles.add(name);
          onStatus?.(`📥 New file detected: ${name}`);
          try {
            const fh   = await _dirHandle.getFileHandle(name);
            const file = await fh.getFile();
            _onNewFile?.(file);
          } catch (e) {
            onStatus?.(`⚠ Could not read ${name}: ${e.message}`);
          }
        }
      }
    } catch (err) {
      // Directory may have become inaccessible
      onStatus?.(`⚠ Watch poll error: ${err.message}`);
    }
  }

  function stop() {
    _active = false;
    if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
    _dirHandle = null;
    _knownFiles.clear();
  }

  function isActive()      { return _active; }
  function getDirName()    { return _dirHandle?.name || '—'; }
  function setPollMs(ms)   { _pollMs = Math.max(1000, ms); }
  function isSupported()   { return !!window.showDirectoryPicker; }

  function _isSupported(name) {
    return /\.(stl|obj|ply)$/i.test(name);
  }

  return { start, stop, isActive, getDirName, setPollMs, isSupported };
})();


// ═══════════════════════════════════════════════════════════
// 2. NESTING PREVIEW — arrange restorations on a milling blank
// ═══════════════════════════════════════════════════════════
const NestingPreview = (() => {

  /**
   * Standard milling blank sizes (width × height in mm).
   * Depth is also listed but not used in 2D top-down preview.
   */
  const BLANK_SIZES = {
    '98 × 14 mm (Standard)':  { w: 98,  h: 14, label: '98 × 14 mm' },
    '98 × 18 mm':              { w: 98,  h: 18, label: '98 × 18 mm' },
    '98 × 20 mm (Extended)':  { w: 98,  h: 20, label: '98 × 20 mm' },
    '71 × 14 mm (Small)':     { w: 71,  h: 14, label: '71 × 14 mm' },
    '40 × 28 mm (Disc)':      { w: 40,  h: 28, label: '40 × 28 mm' },
  };

  /**
   * Render a top-down 2D nesting preview of geometries on a blank.
   *
   * @param {HTMLCanvasElement} canvas       — target canvas element
   * @param {THREE.BufferGeometry[]} geos    — array of BufferGeometries to place
   * @param {string} blankKey               — key in BLANK_SIZES
   * @param {object} opts
   *   padding  {number}  — gap between items (mm, default 2)
   *   margin   {number}  — margin from blank edge (mm, default 3)
   */
  function render(canvas, geos, blankKey, opts = {}) {
    const blank   = BLANK_SIZES[blankKey] || BLANK_SIZES['98 × 14 mm (Standard)'];
    const padding = opts.padding ?? 2;
    const margin  = opts.margin  ?? 3;

    const ctx = canvas.getContext('2d');
    const cw  = canvas.width;
    const ch  = canvas.height;

    // Scale: fit blank width into canvas
    const scale = (cw - 40) / blank.w;
    const bpxW  = blank.w * scale;
    const bpxH  = blank.h * scale;
    const offX  = (cw - bpxW) / 2;
    const offY  = (ch - bpxH) / 2;

    // Clear
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#111113';
    ctx.fillRect(0, 0, cw, ch);

    // Draw blank outline
    ctx.strokeStyle = '#555';
    ctx.lineWidth   = 1.5;
    ctx.fillStyle   = '#1a1a22';
    ctx.beginPath();
    ctx.roundRect(offX, offY, bpxW, bpxH, 4);
    ctx.fill();
    ctx.stroke();

    // Blank label
    ctx.fillStyle   = '#555';
    ctx.font        = '10px Segoe UI, sans-serif';
    ctx.textAlign   = 'left';
    ctx.fillText(`Blank: ${blank.label}`, offX + 4, offY + bpxH + 14);

    if (!geos || !geos.length) {
      ctx.fillStyle = '#444';
      ctx.font = '11px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No restorations to nest', cw / 2, ch / 2);
      return;
    }

    // Compute 2D bounding boxes for each geo (X-Z plane = top-down)
    const boxes = geos.map(geo => _getBBox2D(geo));

    // Simple bin-packing: place items left-to-right, wrap to next row
    let curX = margin;
    let curY = margin;
    let rowH = 0;
    const placed = [];

    for (let i = 0; i < boxes.length; i++) {
      const { w, d } = boxes[i]; // w = X extent, d = Z extent (depth = Y in top-down)
      const itemW = w + padding;
      const itemD = d + padding;

      if (curX + itemW > blank.w - margin && curX > margin) {
        // Wrap to next row
        curX  = margin;
        curY += rowH + padding;
        rowH  = 0;
      }

      if (curY + itemD > blank.h - margin) {
        // No more space — mark remaining as unplaced
        placed.push({ ...boxes[i], px: null, py: null, idx: i });
        continue;
      }

      placed.push({ ...boxes[i], px: curX, py: curY, idx: i });
      curX += itemW;
      rowH = Math.max(rowH, itemD);
    }

    // Draw placed items
    placed.forEach((item, i) => {
      if (item.px === null) {
        // Draw warning
        ctx.fillStyle = '#f14c4c';
        ctx.font = '10px Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`⚠ Item ${i + 1} doesn't fit`, cw / 2, offY + bpxH + 28);
        return;
      }

      const rx = offX + item.px * scale;
      const ry = offY + item.py * scale;
      const rw = item.w * scale;
      const rh = item.d * scale;

      // Item box
      ctx.fillStyle   = _itemColor(i);
      ctx.strokeStyle = '#007acc';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.roundRect(rx, ry, Math.max(rw, 4), Math.max(rh, 4), 2);
      ctx.fill();
      ctx.stroke();

      // Item label
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.font = `${Math.max(8, Math.min(11, rw * 0.3))}px Segoe UI, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(
        `#${i + 1}  ${item.w.toFixed(1)}×${item.d.toFixed(1)}`,
        rx + rw / 2,
        ry + rh / 2 + 4
      );
    });

    // Utilisation
    const usedArea   = placed
      .filter(p => p.px !== null)
      .reduce((s, p) => s + p.w * p.d, 0);
    const blankArea  = blank.w * blank.h;
    const utilPct    = ((usedArea / blankArea) * 100).toFixed(1);
    ctx.fillStyle    = '#9cdcfe';
    ctx.font         = '10px Segoe UI, sans-serif';
    ctx.textAlign    = 'right';
    ctx.fillText(`Utilisation: ${utilPct}%`, offX + bpxW, offY - 6);
  }

  /** Get 2D bounding box (X-Z top-down view) */
  function _getBBox2D(geo) {
    const pos = geo.getAttribute('position');
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { w: maxX - minX, d: maxZ - minZ };
  }

  function _itemColor(idx) {
    const palette = [
      'rgba(0,122,204,0.55)',
      'rgba(78,201,176,0.55)',
      'rgba(197,134,192,0.55)',
      'rgba(220,220,170,0.55)',
      'rgba(206,145,120,0.55)',
      'rgba(156,220,254,0.55)',
    ];
    return palette[idx % palette.length];
  }

  function getBlankSizes() { return Object.keys(BLANK_SIZES); }

  return { render, getBlankSizes, BLANK_SIZES };
})();


// ═══════════════════════════════════════════════════════════
// 3. SUPPORT GENERATOR — naive vertical columns under overhangs
// ═══════════════════════════════════════════════════════════
const SupportGenerator = (() => {

  /**
   * ⚠ PREVIEW ONLY — This support generation is a simplified visual
   *   approximation. Do NOT use output for actual manufacturing without
   *   review by a qualified CAM engineer or dental technician.
   *
   * Generates simple vertical cylinder supports under vertices that
   * overhang (are not directly above another surface).
   *
   * @param {THREE.BufferGeometry} geo       — input geometry
   * @param {object} opts
   *   buildDirection {string}  — 'up' or 'down' (default 'down')
   *   overhangAngle  {number}  — degrees above which a face is considered
   *                              overhanging (default 45°)
   *   supportRadius  {number}  — cylinder radius in scene units (default 0.05)
   *   gridSpacing    {number}  — grid cell size for support placement (default 0.5)
   * @returns {THREE.BufferGeometry}  merged geometry (original + supports)
   *   The returned geometry has userData.supportsAdded = true.
   */
  function generate(geo, opts = {}) {
    const buildDir     = opts.buildDirection ?? 'down';
    const overhangDeg  = opts.overhangAngle  ?? 45;
    const supportR     = opts.supportRadius  ?? 0.05;
    const gridSpacing  = opts.gridSpacing    ?? 0.5;

    const overhangRad  = THREE.MathUtils.degToRad(overhangDeg);
    const upVec        = buildDir === 'up' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, -1, 0);

    // Collect overhanging vertex positions
    const pos  = geo.getAttribute('position');
    let norm = geo.getAttribute('normal');
    if (!norm) {
      geo.computeVertexNormals();
      norm = geo.getAttribute('normal');
    }

    // Use a grid to avoid duplicate supports
    const grid     = new Map();
    const supports = [];

    // Find bounding box Y min (build plate level)
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
    }
    const buildPlateY = minY - 0.1; // slightly below lowest point

    for (let i = 0; i < pos.count; i++) {
      const nx = norm ? norm.getX(i) : 0;
      const ny = norm ? norm.getY(i) : 1;
      const nz = norm ? norm.getZ(i) : 0;
      const n  = new THREE.Vector3(nx, ny, nz).normalize();

      // Angle between face normal and build direction
      const angle = Math.acos(Math.max(-1, Math.min(1, n.dot(upVec))));
      if (angle < overhangRad) continue; // not overhanging enough

      const vx = pos.getX(i);
      const vy = pos.getY(i);
      const vz = pos.getZ(i);

      // Grid key — quantise to gridSpacing
      const gx = Math.round(vx / gridSpacing);
      const gz = Math.round(vz / gridSpacing);
      const key = `${gx}_${gz}`;

      // Keep the highest overhanging vertex per cell
      if (!grid.has(key) || grid.get(key).y < vy) {
        grid.set(key, { x: vx, y: vy, z: vz });
      }
    }

    // Build a cylinder from each grid cell vertex down to build plate
    for (const [, { x, y, z }] of grid) {
      const height = y - buildPlateY;
      if (height < 0.05) continue;  // too short to bother
      const cyl = new THREE.CylinderGeometry(supportR, supportR, height, 6);
      // Position centre of cylinder at mid-height
      for (let i = 0; i < cyl.attributes.position.count; i++) {
        cyl.attributes.position.setXYZ(
          i,
          cyl.attributes.position.getX(i) + x,
          cyl.attributes.position.getY(i) + (buildPlateY + height / 2),
          cyl.attributes.position.getZ(i) + z
        );
      }
      cyl.attributes.position.needsUpdate = true;
      cyl.computeVertexNormals();
      supports.push(cyl);
    }

    if (!supports.length) {
      Logger?.info('SupportGen', 'No overhanging faces found — no supports needed');
      const out = geo.clone();
      out.userData.supportsAdded = true;
      out.userData.supportCount  = 0;
      return out;
    }

    // Merge original + all supports
    const merged = _mergeGeometries([geo, ...supports]);
    merged.userData.supportsAdded = true;
    merged.userData.supportCount  = supports.length;
    Logger?.info('SupportGen', `Added ${supports.length} support columns`);
    return merged;
  }

  function _mergeGeometries(geos) {
    const allPos = [], allNor = [];
    for (const g of geos) {
      const p = g.attributes.position;
      const n = g.attributes.normal;
      for (let i = 0; i < p.count; i++) {
        allPos.push(p.getX(i), p.getY(i), p.getZ(i));
        if (n) allNor.push(n.getX(i), n.getY(i), n.getZ(i));
        else   allNor.push(0, 1, 0);
      }
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(allPos), 3));
    out.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(allNor), 3));
    return out;
  }

  return { generate };
})();

// Global exports
window.FolderWatch        = FolderWatch;
window.NestingPreview     = NestingPreview;
window.SupportGenerator   = SupportGenerator;

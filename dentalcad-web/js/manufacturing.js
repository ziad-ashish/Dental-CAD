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
   * Calculate a deterministic top-down layout and report manufacturing
   * overflow before anything is sent to a CAM process.
   */
  function planLayout(geos, blankKey, opts = {}) {
    const blank = BLANK_SIZES[blankKey] || BLANK_SIZES['98 × 14 mm (Standard)'];
    const rawPadding = Number(opts.padding ?? 2);
    const rawMargin = Number(opts.margin ?? 3);
    if (!Number.isFinite(rawPadding) || rawPadding < 0 || !Number.isFinite(rawMargin) || rawMargin < 0) {
      throw new Error('Nesting padding and margin must be finite non-negative numbers');
    }
    const padding = rawPadding;
    const margin = rawMargin;
    const matrices = opts.worldMatrices || [];
    const boxes = (geos || []).map((geo, i) => _getBBox2D(geo, matrices[i] || opts.worldMatrix || null));
    let curX = margin, curY = margin, rowH = 0;
    const placements = [];
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const itemW = box.w + padding;
      const itemD = box.d + padding;
      if (curX + itemW > blank.w - margin && curX > margin) {
        curX = margin; curY += rowH + padding; rowH = 0;
      }
      const fits = box.w <= blank.w - 2 * margin && box.d <= blank.h - 2 * margin && curY + itemD <= blank.h - margin;
      placements.push({ ...box, px: fits ? curX : null, py: fits ? curY : null, idx: i, fits });
      if (fits) { curX += itemW; rowH = Math.max(rowH, itemD); }
    }
    const placed = placements.filter(p => p.fits);
    const usedArea = placed.reduce((sum, p) => sum + p.w * p.d, 0);
    return {
      blank: { ...blank },
      padding,
      margin,
      placements,
      overflow: placements.filter(p => !p.fits).map(p => p.idx),
      utilization: blank.w * blank.h ? usedArea / (blank.w * blank.h) : 0,
    };
  }

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

    const plan = planLayout(geos, blankKey, { padding, margin, worldMatrices: opts.worldMatrices, worldMatrix: opts.worldMatrix });
    const placed = plan.placements;

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
  function _getBBox2D(geo, worldMatrix = null) {
    const pos = geo.getAttribute('position');
    let minX = Infinity, maxX = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const point = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (worldMatrix) point.applyMatrix4(worldMatrix);
      const x = point.x, z = point.z;
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

  return { render, planLayout, getBlankSizes, BLANK_SIZES };
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
    const supportHeights = [];

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
      supportHeights.push(height);
    }

    if (!supports.length) {
      Logger?.info('SupportGen', 'No overhanging faces found — no supports needed');
      const out = geo.clone();
      out.userData.supportsAdded = true;
      out.userData.supportCount  = 0;
      out.userData.supportStats  = { candidateCells: grid.size, minHeight: 0, maxHeight: 0, buildPlateY };
      return out;
    }

    // Merge original + all supports
    const merged = _mergeGeometries([geo, ...supports]);
    merged.userData.supportsAdded = true;
    merged.userData.supportCount  = supports.length;
    merged.userData.supportStats  = { candidateCells: grid.size, minHeight: Math.min(...supportHeights), maxHeight: Math.max(...supportHeights), buildPlateY };
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

// ═══════════════════════════════════════════════════════════
// 4. TOOLPATH PLANNER — conservative 3-axis roughing preview
// ═══════════════════════════════════════════════════════════
const ToolpathPlanner = (() => {
  function _bounds(geometry, worldMatrix = null) {
    const pos = geometry?.getAttribute?.('position');
    if (!pos || !pos.count) throw new Error('A mesh geometry is required');
    if (pos.count % 3 !== 0) throw new Error('Mesh must contain complete triangles');
    const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (let i = 0; i < pos.count; i++) {
      const point = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (worldMatrix) point.applyMatrix4(worldMatrix);
      const x = point.x, y = point.y, z = point.z;
      if (![x, y, z].every(Number.isFinite)) throw new Error('Mesh contains non-finite coordinates');
      b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x);
      b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y);
      b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z);
    }
    return b;
  }

  function plan(geometry, opts = {}) {
    const bounds = _bounds(geometry, opts.worldMatrix || null);
    const stepdown = Number(opts.stepdown ?? 0.5);
    const stepover = Number(opts.stepover ?? 1.0);
    const margin = Number(opts.margin ?? 0.5);
    const safeHeight = Number(opts.safeHeight ?? bounds.maxY + 5);
    const feed = Number(opts.feed ?? 600);
    const plungeFeed = Number(opts.plungeFeed ?? 120);
    if (![stepdown, stepover, margin, safeHeight, feed, plungeFeed].every(Number.isFinite) || stepdown <= 0 || stepover <= 0 || margin < 0 || feed <= 0 || plungeFeed <= 0) throw new Error('Invalid toolpath parameters');
    if (safeHeight <= bounds.maxY) throw new Error('Safe height must be above the mesh');
    const minX = bounds.minX - margin, maxX = bounds.maxX + margin;
    const minZ = bounds.minZ - margin, maxZ = bounds.maxZ + margin;
    const moves = [{ kind: 'rapid', x: minX, y: safeHeight, z: minZ }];
    let layerCount = 0, rowCount = 0, reverse = false;
    for (let y = bounds.maxY; y >= bounds.minY - 1e-9; y -= stepdown) {
      const layerY = Math.max(y, bounds.minY);
      layerCount++;
      let row = 0;
      for (let z = minZ; z <= maxZ + 1e-9; z += stepover) {
        const rowZ = Math.min(z, maxZ);
        const fromX = reverse ? maxX : minX;
        const toX = reverse ? minX : maxX;
        moves.push({ kind: 'rapid', x: fromX, y: safeHeight, z: rowZ });
        moves.push({ kind: 'plunge', x: fromX, y: layerY, z: rowZ, feed: plungeFeed });
        moves.push({ kind: 'cut', x: toX, y: layerY, z: rowZ, feed });
        reverse = !reverse; row++; rowCount++;
        if (z + stepover > maxZ && row > 0) break;
      }
    }
    moves.push({ kind: 'rapid', x: minX, y: safeHeight, z: minZ });
    return Object.freeze({ version: 1, bounds, parameters: { stepdown, stepover, margin, safeHeight, feed, plungeFeed }, moves, layerCount, rowCount });
  }

  function validate(path) {
    const errors = [];
    if (!path || path.version !== 1) errors.push('Unsupported toolpath version');
    if (!Array.isArray(path?.moves) || path.moves.length < 4) errors.push('Toolpath has too few moves');
    if (path?.parameters?.safeHeight <= path?.bounds?.maxY) errors.push('Toolpath safe height is unsafe');
    if (path?.bounds && !['minX','maxX','minY','maxY','minZ','maxZ'].every(k => Number.isFinite(path.bounds[k]))) errors.push('Toolpath bounds are invalid');
    if (path?.moves?.length && path.moves[0].kind !== 'rapid') errors.push('Toolpath must begin with a rapid move');
    for (const move of path?.moves || []) {
      if (!['rapid', 'plunge', 'cut'].includes(move.kind)) errors.push('Unknown toolpath move');
      if (![move.x, move.y, move.z].every(Number.isFinite)) errors.push('Toolpath contains non-finite coordinates');
      if ((move.kind === 'plunge' || move.kind === 'cut') && (!Number.isFinite(move.feed) || move.feed <= 0)) errors.push('Cutting move has invalid feed');
      if (move.kind === 'rapid' && Number.isFinite(path?.parameters?.safeHeight) && move.y < path.parameters.safeHeight) errors.push('Rapid move below safe height');
      if ((move.kind === 'plunge' || move.kind === 'cut') && path?.bounds && (move.y < path.bounds.minY || move.y > path.bounds.maxY)) errors.push('Cutting move outside mesh bounds');
      const margin = Number(path?.parameters?.margin);
      if (path?.bounds && Number.isFinite(margin) && (move.x < path.bounds.minX - margin || move.x > path.bounds.maxX + margin || move.z < path.bounds.minZ - margin || move.z > path.bounds.maxZ + margin)) errors.push('Toolpath move outside XY machining envelope');
    }
    return { valid: errors.length === 0, errors };
  }

  const MACHINE_PROFILES = Object.freeze({
    generic: { label: 'Generic 3-axis', spindle: 12000, feedScale: 1, lineEnding: '\n' },
    roland:  { label: 'Roland DG milling', spindle: 10000, feedScale: 0.8, lineEnding: '\r\n' },
    vhf:     { label: 'vhf dental milling', spindle: 15000, feedScale: 1.1, lineEnding: '\r\n' },
  });

  function toGCode(path, opts = {}) {
    const check = validate(path);
    if (!check.valid) throw new Error(check.errors.join('; '));
    const machine = String(opts.machine || 'generic').toLowerCase();
    const profile = MACHINE_PROFILES[machine];
    if (!profile) throw new Error(`Unknown machine profile: ${machine}`);
    const lines = [
      `; DentalCAD conservative roughing toolpath v${path.version}`,
      `; Machine: ${profile.label}`,
      `; Layers: ${path.layerCount}  Rows: ${path.rowCount}`,
      `; WARNING: Review and post-process for the target machine before use`,
      'G21', 'G90', 'G17', `M3 S${profile.spindle}`,
    ];
    for (const m of path.moves) {
      const code = m.kind === 'rapid' ? 'G0' : 'G1';
      const feed = m.feed ? ` F${(m.feed * profile.feedScale).toFixed(1)}` : '';
      lines.push(`${code} X${m.x.toFixed(4)} Y${m.y.toFixed(4)} Z${m.z.toFixed(4)}${feed}`);
    }
    lines.push('M5', 'M30');
    return lines.join(profile.lineEnding);
  }

  function validateGCode(text, machine = 'generic') {
    const errors = [];
    const profile = MACHINE_PROFILES[String(machine).toLowerCase()];
    if (!profile) errors.push(`Unknown machine profile: ${machine}`);
    if (typeof text !== 'string' || !text.trim()) errors.push('G-code is empty');
    else {
      if (!text.includes('G21')) errors.push('Missing metric units command');
      if (!text.includes('G90')) errors.push('Missing absolute positioning command');
      if (!text.includes('M30')) errors.push('Missing program end command');
      if (!/\bM5(?:\s|$)/m.test(text)) errors.push('Missing spindle stop command');
      if (/NaN|Infinity|undefined/.test(text)) errors.push('G-code contains invalid numeric values');
      for (const line of text.split(/\r?\n/)) {
        const motion = line.trim().match(/^G[01]\s+(.+)$/i);
        if (!motion) continue;
        for (const token of motion[1].trim().split(/\s+/)) {
          if (!/^[XYZFS][+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/i.test(token)) errors.push(`Invalid G-code coordinate token: ${token}`);
        }
      }
      if (profile && !text.includes(`Machine: ${profile.label}`)) errors.push('Machine profile header mismatch');
    }
    return { valid: errors.length === 0, errors };
  }

  return { plan, validate, toGCode, validateGCode, MACHINE_PROFILES };
})();

// ═══════════════════════════════════════════════════════════
// 5. MANUFACTURING JOB — auditable CAM handoff metadata
// ═══════════════════════════════════════════════════════════
const ManufacturingJob = (() => {
  function create({ geometry, caseId = 'Case', blankKey = '98 × 14 mm (Standard)', padding = 2, supportsAdded = false, supportCount = 0, toolpath = null, machine = 'generic', worldMatrix = null } = {}) {
    if (!geometry?.getAttribute) throw new Error('A mesh geometry is required');
    const pos = geometry.getAttribute('position');
    if (!pos || !pos.count || pos.count % 3 !== 0) throw new Error('Mesh must contain complete triangles');
    for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i])) throw new Error('Mesh contains non-finite coordinates');
    const layout = NestingPreview.planLayout([geometry], blankKey, { padding, worldMatrices: worldMatrix ? [worldMatrix] : [] });
    const overflow = layout.overflow.length > 0;
    let toolpathSummary = null;
    if (toolpath) {
      const check = ToolpathPlanner.validate(toolpath);
      if (!check.valid) throw new Error(check.errors.join('; '));
      if (!ToolpathPlanner.MACHINE_PROFILES[machine]) throw new Error(`Unknown machine profile: ${machine}`);
      toolpathSummary = { version: toolpath.version, machine, layerCount: toolpath.layerCount, rowCount: toolpath.rowCount, moveCount: toolpath.moves.length };
    }
    const job = {
      version: 1,
      caseId: String(caseId || 'Case'),
      createdAt: new Date().toISOString(),
      blankKey,
      blank: layout.blank,
      padding: layout.padding,
      triangleCount: pos.count / 3,
      supportsAdded: !!supportsAdded,
      supportCount: Math.max(0, Number(supportCount) || 0),
      supportStats: geometry.userData?.supportStats || null,
      utilization: layout.utilization,
      overflow,
      toolpath: toolpathSummary,
      status: overflow ? 'blocked' : 'ready',
    };
    return Object.freeze(job);
  }

  function validate(job) {
    const errors = [];
    if (!job || job.version !== 1) errors.push('Unsupported manufacturing job version');
    if (!job?.caseId) errors.push('Missing case ID');
    if (!Number.isFinite(job?.triangleCount) || job.triangleCount < 1) errors.push('Invalid triangle count');
    if (job?.overflow) errors.push('Nesting overflow must be resolved');
    if (!job?.blank || !(job.blank.w > 0 && job.blank.h > 0)) errors.push('Invalid blank dimensions');
    if (job?.toolpath && (!job.toolpath.machine || !Number.isFinite(job.toolpath.layerCount) || !Number.isFinite(job.toolpath.rowCount) || !Number.isFinite(job.toolpath.moveCount) || job.toolpath.moveCount < 1)) errors.push('Invalid toolpath summary');
    return { valid: errors.length === 0, errors };
  }

  function toJSON(job) {
    const check = validate(job);
    if (!check.valid) throw new Error(check.errors.join('; '));
    return JSON.stringify(job, null, 2);
  }

  return { create, validate, toJSON };
})();

// Global exports
window.FolderWatch        = FolderWatch;
window.NestingPreview     = NestingPreview;
window.SupportGenerator   = SupportGenerator;
window.ToolpathPlanner    = ToolpathPlanner;
window.ManufacturingJob   = ManufacturingJob;

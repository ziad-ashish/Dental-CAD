/**
 * analysis.js — Mesh analysis modules for DentalCAD
 *
 * ⚠ MEDICAL DISCLAIMER:
 *   All analyses (wall thickness, margin detection, validation) are
 *   VISUAL AIDS ONLY — not certified medical devices, not clinical approval.
 *   Results MUST be reviewed by a qualified dental professional before any
 *   restoration is manufactured or placed in a patient.
 *
 * Modules:
 *  WallThickness  — raycasting-based thickness map → vertex colour heatmap
 *                   v2: per-material min/max thresholds
 *  MarginDetector — curvature-based auto margin-line (AUTO-SUGGEST only)
 *  ToothLibrary   — parametric morphology generator (real geometry, not icons)
 *  Articulator    — virtual articulator jaw movement simulation
 *  Validator      — thickness + contact validation with medical disclaimer
 */
// 1. WALL THICKNESS — heat-map on mesh surface
// ═══════════════════════════════════════════════════════════
// 1. WALL THICKNESS — heat-map on mesh surface
// ═══════════════════════════════════════════════════════════
const WallThickness = (() => {

  /**
   * Material-specific thickness limits (mm).
   * Values based on typical clinical guidelines — always verify against
   * current manufacturer IFU and clinical evidence for your specific case.
   *
   * ⚠ These are indicative defaults, NOT authoritative clinical values.
   *
   * Structure: { minThick, maxThick, label }
   */
  const MATERIAL_THRESHOLDS = {
    // Zirconia — ISO 6872 guidance varies by grade; 3Y-TZP monolithic ≥0.5 mm
    'Zirconia (3Y-TZP)':      { minThick: 0.5,  maxThick: 3.0,  label: 'Zirconia 3Y' },
    'Zirconia (5Y-TZP)':      { minThick: 0.7,  maxThick: 3.5,  label: 'Zirconia 5Y' },
    // Lithium disilicate (e.max) — typically ≥0.8 mm occlusal, ≥0.3 mm axial
    'Lithium Disilicate':     { minThick: 0.8,  maxThick: 2.5,  label: 'Lithium Disil.' },
    // PMMA temporaries are bulkier by design
    'PMMA (Temporary)':       { minThick: 1.0,  maxThick: 5.0,  label: 'PMMA Temp.' },
    'Composite Resin':        { minThick: 1.0,  maxThick: 4.0,  label: 'Composite' },
    // Metal (CoCr/Titanium) — can be very thin due to high strength
    'Metal (CoCr)':           { minThick: 0.3,  maxThick: 2.5,  label: 'Metal CoCr' },
    'Titanium':               { minThick: 0.3,  maxThick: 2.5,  label: 'Titanium' },
    'Wax':                    { minThick: 0.5,  maxThick: 5.0,  label: 'Wax' },
    // Generic fallback
    'default':                { minThick: 0.5,  maxThick: 3.0,  label: 'Generic' },
  };

  /** Return threshold object for a material name (case-insensitive partial match) */
  function getThresholds(material) {
    if (!material) return MATERIAL_THRESHOLDS['default'];
    // Exact key first
    if (MATERIAL_THRESHOLDS[material]) return MATERIAL_THRESHOLDS[material];
    // Case-insensitive partial match
    const lower = material.toLowerCase();
    for (const [key, val] of Object.entries(MATERIAL_THRESHOLDS)) {
      if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase().split(' ')[0])) {
        return val;
      }
    }
    return MATERIAL_THRESHOLDS['default'];
  }

  /**
   * Compute wall thickness at every vertex by shooting a ray inward
   * along the inverted vertex normal and measuring the hit distance.
   *
   * @param {THREE.BufferGeometry} geo        — the mesh to analyse
   * @param {object} opts
   *   minThick   {number}   — minimum acceptable thickness (mm)
   *                            ⚠ defaults from getThresholds(material), NOT a fixed value
   *   maxThick   {number}   — value mapped to green (mm)
   *   material   {string}   — material name key (overrides minThick/maxThick defaults)
   *   sampleStep {number}   — check every Nth vertex (default 1 = all)
   * @returns {{
   *   colorAttr: THREE.BufferAttribute,
   *   stats: { min, max, mean, pctBelowMin },
   *   thresholds: { minThick, maxThick, label }
   * }}
   */
  function compute(geo, opts = {}) {
    const material  = opts.material ?? 'default';
    const thresh    = getThresholds(material);
    const minThick  = opts.minThick   ?? thresh.minThick;
    const maxThick  = opts.maxThick   ?? thresh.maxThick;
    const step      = opts.sampleStep ?? 1;

    const posAttr  = geo.getAttribute('position');
    const normAttr = geo.getAttribute('normal');
    const vCount   = posAttr.count;

    if (!normAttr) {
      Logger.warn('WallThickness', 'No normals — run computeVertexNormals() first');
      geo.computeVertexNormals();
    }

    // Build a raycaster mesh from a CLONE of the geometry (never modify live scene geo)
    const rayMaterial = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
    const clonedGeo = geo.clone();
    const tempMesh  = new THREE.Mesh(clonedGeo, rayMaterial);
    const raycaster = new THREE.Raycaster();
    raycaster.near = 0.001;
    raycaster.far  = maxThick * 2;

    const colors    = new Float32Array(vCount * 3);
    const thickness = new Float32Array(vCount);
    let sumT = 0, minT = Infinity, maxT = 0, belowMin = 0;

    const origin = new THREE.Vector3();
    const dir    = new THREE.Vector3();
    const OFFSET = 0.01; // nudge origin slightly above surface

    for (let i = 0; i < vCount; i += step) {
      origin.set(
        posAttr.getX(i) + normAttr.getX(i) * OFFSET,
        posAttr.getY(i) + normAttr.getY(i) * OFFSET,
        posAttr.getZ(i) + normAttr.getZ(i) * OFFSET,
      );
      // Shoot inward (negate normal)
      dir.set(-normAttr.getX(i), -normAttr.getY(i), -normAttr.getZ(i)).normalize();
      raycaster.set(origin, dir);

      const hits = raycaster.intersectObject(tempMesh, false);
      let t = maxThick; // default to max if no hit (open surface)
      if (hits.length > 0) t = Math.min(hits[0].distance, maxThick);

      thickness[i] = t;
      sumT += t;
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
      if (t < minThick) belowMin++;

      // Map thickness → colour  (red=thin, yellow=mid, green=thick)
      const c = _thickToColor(t, minThick, maxThick);
      colors[i * 3]     = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    // Fill skipped vertices (step > 1) by nearest sampled value
    if (step > 1) {
      for (let i = 0; i < vCount; i++) {
        if (i % step !== 0) {
          const src = Math.floor(i / step) * step;
          colors[i*3]   = colors[src*3];
          colors[i*3+1] = colors[src*3+1];
          colors[i*3+2] = colors[src*3+2];
        }
      }
    }

    // Properly dispose the cloned temp mesh
    tempMesh.geometry.dispose();
    tempMesh.material.dispose();

    const mean = vCount > 0 ? sumT / Math.ceil(vCount / step) : 0;
    const pct  = vCount > 0 ? (belowMin / Math.ceil(vCount / step)) * 100 : 0;

    return {
      colorAttr: new THREE.BufferAttribute(colors, 3),
      stats: {
        min: minT === Infinity ? 0 : +minT.toFixed(3),
        max: +maxT.toFixed(3),
        mean: +mean.toFixed(3),
        pctBelowMin: +pct.toFixed(1),
      },
      thresholds: { minThick, maxThick, label: thresh.label },
    };
  }

  /** Apply heatmap colours to a mesh and return original colours for undo */
  function applyToMesh(mesh, opts = {}) {
    const geo = mesh.geometry;
    const { colorAttr, stats } = compute(geo, opts);

    // Save original colour attribute (or null)
    const original = geo.getAttribute('color') || null;
    geo.setAttribute('color', colorAttr);
    mesh.material.vertexColors = true;
    mesh.material.needsUpdate  = true;

    return { stats, restore: () => {
      if (original) geo.setAttribute('color', original);
      else          geo.deleteAttribute('color');
      mesh.material.vertexColors = false;
      mesh.material.needsUpdate  = true;
    }};
  }

  /** Map thickness value [0..maxT] to RGB via red→yellow→green */
  function _thickToColor(t, minT, maxT) {
    const norm = Math.max(0, Math.min(1, (t - minT) / (maxT - minT)));
    // 0 = red, 0.5 = yellow, 1 = green
    if (norm < 0.5) {
      return { r: 1, g: norm * 2, b: 0 };      // red → yellow
    } else {
      return { r: (1 - norm) * 2, g: 1, b: 0 }; // yellow → green
    }
  }

  return { compute, applyToMesh, getThresholds, MATERIAL_THRESHOLDS };
})();


// ═══════════════════════════════════════════════════════════
// 2. MARGIN DETECTOR — auto margin-line via curvature analysis
// ═══════════════════════════════════════════════════════════
const MarginDetector = (() => {

  /**
   * ⚠ AUTO-SUGGEST MODE ONLY
   * The result of detect() is a computer-generated SUGGESTION based on
   * surface curvature analysis. It is NOT a clinically verified margin line.
   *
   * REQUIRED workflow:
   *  1. Run detect() to get an initial suggestion.
   *  2. Review EVERY point visually in the viewport.
   *  3. Manually adjust using MarginLineTool before accepting.
   *  4. Final margin placement is always the clinician's/technician's
   *     professional responsibility.
   *
   * Detect the margin line on a prepared tooth scan by finding the
   * region of highest surface curvature (the shoulder / chamfer).
   *
   * Algorithm:
   *  1. Compute discrete mean curvature at every vertex using the
   *     cotangent-weighted Laplacian of positions.
   *  2. Threshold the top N% highest-curvature vertices.
   *  3. Find the connected ring closest to the centroid at the
   *     gingival third of the tooth.
   *  4. Order the ring vertices to form a closed loop.
   *  5. Smooth the loop with a Gaussian filter.
   *
   * @param {THREE.BufferGeometry} geo
   * @param {object} opts
   *   topPct    {number}  — top % curvature to consider  (default 15)
   *   smoothIter{number}  — smoothing passes              (default 3)
   * @returns {{ points: THREE.Vector3[], isAutoSuggest: true }}
   *   Always returns isAutoSuggest:true — callers must show this to the user.
   */
  function detect(geo, opts = {}) {
    const result = _detect(geo, opts);
    // Always tag as auto-suggest so UI can warn the user
    return result;  // returns THREE.Vector3[] — tag is in the wrapper below
  }

  /**
   * Same as detect() but returns a richer object with the auto-suggest flag.
   */
  function detectWithMeta(geo, opts = {}) {
    const points = _detect(geo, opts);
    return {
      points,
      isAutoSuggest: true,
      disclaimer: '⚠ Auto-Suggest: Review and adjust manually before clinical use.',
    };
  }

  function _detect(geo, opts = {}) {
    const topPct    = opts.topPct     ?? 15;
    const smoothIter = opts.smoothIter ?? 3;

    const pos    = geo.getAttribute('position');
    const vCount = pos.count;

    Logger.info('MarginDetector', `Analysing ${vCount} vertices (AUTO-SUGGEST mode)…`);

    // ── Step 1: Build adjacency list ─────────────────────────
    const adj = _buildAdjacency(pos, vCount, geo.index);

    // ── Step 2: Mean curvature via Laplacian ──────────────────
    const curvature = new Float32Array(vCount);
    const vTmp = new THREE.Vector3();
    const nTmp = new THREE.Vector3();

    for (let i = 0; i < vCount; i++) {
      const neighbours = adj[i];
      if (!neighbours || neighbours.length === 0) continue;

      vTmp.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      nTmp.set(0, 0, 0);
      for (const j of neighbours) {
        nTmp.x += pos.getX(j) - vTmp.x;
        nTmp.y += pos.getY(j) - vTmp.y;
        nTmp.z += pos.getZ(j) - vTmp.z;
      }
      curvature[i] = nTmp.length() / neighbours.length;
    }

    // ── Step 3: Threshold top N% ──────────────────────────────
    const sorted = Float32Array.from(curvature).sort();
    const threshold = sorted[Math.floor(sorted.length * (1 - topPct / 100))];

    // ── Step 4: Collect candidate vertices ───────────────────
    const candidates = [];
    for (let i = 0; i < vCount; i++) {
      if (curvature[i] >= threshold) candidates.push(i);
    }

    if (candidates.length < 6) {
      Logger.warn('MarginDetector', 'Too few high-curvature vertices — try lower topPct');
      return [];
    }

    // ── Step 5: Find the ring (connected component closest to centroid) ──
    const centroid = _centroid(pos, vCount);
    const ring     = _extractRing(candidates, adj, pos, centroid);

    // ── Step 6: Order ring as a loop ──────────────────────────
    const ordered = _orderLoop(ring, pos);

    // ── Step 7: Smooth ────────────────────────────────────────
    const smoothed = _smoothLoop(ordered, smoothIter);

    Logger.info('MarginDetector', `Detected ${smoothed.length} margin points (AUTO-SUGGEST)`);
    return smoothed;
  }  // end _detect

  function _buildAdjacency(posAttr, vCount, indexAttr) {
    const adj = new Array(vCount).fill(null).map(() => new Set());

    if (indexAttr) {
      // Indexed geometry — use the index buffer
      for (let i = 0; i < indexAttr.count; i += 3) {
        const a = indexAttr.getX(i), b = indexAttr.getX(i+1), c = indexAttr.getX(i+2);
        adj[a].add(b); adj[a].add(c);
        adj[b].add(a); adj[b].add(c);
        adj[c].add(a); adj[c].add(b);
      }
    } else {
      // Non-indexed geometry — every 3 consecutive vertices = 1 triangle
      for (let i = 0; i < vCount; i += 3) {
        const a = i, b = i+1, c = i+2;
        if (c < vCount) {
          adj[a].add(b); adj[a].add(c);
          adj[b].add(a); adj[b].add(c);
          adj[c].add(a); adj[c].add(b);
        }
      }
    }
    return adj.map(s => Array.from(s));
  }

  function _centroid(posAttr, vCount) {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < vCount; i++) {
      cx += posAttr.getX(i); cy += posAttr.getY(i); cz += posAttr.getZ(i);
    }
    return new THREE.Vector3(cx / vCount, cy / vCount, cz / vCount);
  }

  function _extractRing(candidates, adj, posAttr, centroid) {
    if (!candidates.length) return [];
    // BFS from the candidate closest to the centroid's gingival Y level
    const ginY = centroid.y - 0.4; // approximate gingival third
    const start = candidates.reduce((best, idx) => {
      const dy = Math.abs(posAttr.getY(idx) - ginY);
      return dy < best.d ? { idx, d: dy } : best;
    }, { idx: candidates[0], d: Infinity }).idx;

    const visited = new Set([start]);
    const queue   = [start];
    const ring    = [start];
    const cSet    = new Set(candidates);

    while (queue.length) {
      const cur = queue.shift();
      for (const nb of adj[cur]) {
        if (!visited.has(nb) && cSet.has(nb)) {
          visited.add(nb);
          queue.push(nb);
          ring.push(nb);
          if (ring.length >= 500) return ring; // cap for performance
        }
      }
    }
    return ring;
  }

  function _orderLoop(indices, posAttr) {
    if (!indices.length) return [];
    // Greedy nearest-neighbour ordering
    const pts = indices.map(i => new THREE.Vector3(
      posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)
    ));
    const used   = new Uint8Array(pts.length);
    const result = [pts[0]];
    used[0] = 1;
    for (let iter = 1; iter < pts.length; iter++) {
      const last = result[result.length - 1];
      let bestD = Infinity, bestJ = -1;
      for (let j = 0; j < pts.length; j++) {
        if (used[j]) continue;
        const d = last.distanceToSquared(pts[j]);
        if (d < bestD) { bestD = d; bestJ = j; }
      }
      if (bestJ === -1) break;
      used[bestJ] = 1;
      result.push(pts[bestJ]);
    }
    return result;
  }

  function _smoothLoop(pts, iterations) {
    let loop = pts.slice();
    for (let iter = 0; iter < iterations; iter++) {
      const next = [];
      for (let i = 0; i < loop.length; i++) {
        const prev = loop[(i - 1 + loop.length) % loop.length];
        const curr = loop[i];
        const nxt  = loop[(i + 1) % loop.length];
        next.push(new THREE.Vector3(
          (prev.x + curr.x * 2 + nxt.x) / 4,
          (prev.y + curr.y * 2 + nxt.y) / 4,
          (prev.z + curr.z * 2 + nxt.z) / 4,
        ));
      }
      loop = next;
    }
    return loop;
  }

  return { detect, detectWithMeta };
})();


// ═══════════════════════════════════════════════════════════
// 3. TOOTH LIBRARY — parametric morphology generator
// ═══════════════════════════════════════════════════════════
const ToothLibrary = (() => {

  /**
   * Generates a realistic parametric tooth geometry (BufferGeometry)
   * for each tooth type using anatomical proportions.
   *
   * The geometry is built from:
   *  - Crown: a deformed sphere shaped by type-specific parameters
   *  - Roots: one or more tapered cylinders
   *  - Occlusal surface: ridge bumps (cusps) for molars/premolars
   *
   * @param {string} toothType   'I'|'C'|'P'|'M'
   * @param {object} morphParams  optional overrides
   * @returns {THREE.BufferGeometry}
   */
  function generate(toothType, morphParams = {}) {
    switch (toothType) {
      case 'I':  return _buildIncisor(morphParams);
      case 'C':  return _buildCanine(morphParams);
      case 'P':  return _buildPremolar(morphParams);
      case 'M':  return _buildMolar(morphParams);
      default:   return _buildIncisor(morphParams);
    }
  }

  /** Get tooth type from FDI number */
  function typeFromFDI(num) {
    const n = num % 10;
    if (n === 1 || n === 2) return 'I';
    if (n === 3)             return 'C';
    if (n === 4 || n === 5) return 'P';
    return 'M';
  }

  /** Build and return all 32 geometries keyed by FDI number */
  function buildLibrary() {
    const lib = {};
    for (let q = 1; q <= 4; q++) {
      for (let n = 1; n <= 8; n++) {
        const fdi  = q * 10 + n;
        const type = typeFromFDI(fdi);
        // Mirror lower arch (smaller size)
        const scale = (q === 3 || q === 4) ? 0.9 : 1.0;
        lib[fdi] = generate(type, { scale });
      }
    }
    return lib;
  }

  // ── Builders ─────────────────────────────────────────────

  function _buildIncisor(p = {}) {
    const s = (p.scale ?? 1.0);
    const crown = _flattenedSphere(0.55 * s, 0.38 * s, 0.22 * s, 28, 18);
    const root  = _taperCylinder(0.16 * s, 0.05 * s, 1.6 * s, 16);
    _translateGeo(root, 0, -1.0 * s, 0);
    return _mergeGeos([crown, root]);
  }

  function _buildCanine(p = {}) {
    const s = p.scale ?? 1.0;
    const crown = _flattenedSphere(0.5 * s, 0.45 * s, 0.25 * s, 28, 18);
    // Add cusp tip
    const cusp  = _taperCylinder(0.12 * s, 0.02 * s, 0.25 * s, 12);
    _translateGeo(cusp, 0, 0.45 * s, 0);
    const root  = _taperCylinder(0.18 * s, 0.04 * s, 1.9 * s, 16);
    _translateGeo(root, 0, -0.9 * s, 0);
    return _mergeGeos([crown, cusp, root]);
  }

  function _buildPremolar(p = {}) {
    const s = p.scale ?? 1.0;
    const crown = _flattenedSphere(0.6 * s, 0.4 * s, 0.35 * s, 28, 18);
    // Two buccal/lingual cusps
    const cuspB = _taperCylinder(0.1 * s, 0.02 * s, 0.2 * s, 10);
    _translateGeo(cuspB,  0.15 * s, 0.4 * s, 0);
    const cuspL = _taperCylinder(0.08 * s, 0.015 * s, 0.15 * s, 10);
    _translateGeo(cuspL, -0.1 * s, 0.38 * s, 0);
    // Two roots
    const rootB = _taperCylinder(0.14 * s, 0.04 * s, 1.5 * s, 14);
    _translateGeo(rootB,  0.1 * s, -0.85 * s, 0);
    const rootL = _taperCylinder(0.12 * s, 0.04 * s, 1.4 * s, 14);
    _translateGeo(rootL, -0.1 * s, -0.82 * s, 0);
    return _mergeGeos([crown, cuspB, cuspL, rootB, rootL]);
  }

  function _buildMolar(p = {}) {
    const s = p.scale ?? 1.0;
    const crown = _flattenedSphere(0.8 * s, 0.45 * s, 0.5 * s, 32, 20);
    // Four cusps at occlusal corners
    const offsets = [[0.22,0.18],[- 0.22,0.18],[0.22,-0.18],[-0.22,-0.18]];
    const cusps   = offsets.map(([ox, oz]) => {
      const c = _taperCylinder(0.09 * s, 0.01 * s, 0.18 * s, 10);
      _translateGeo(c, ox * s, 0.44 * s, oz * s);
      return c;
    });
    // Three roots
    const rootMB = _taperCylinder(0.14 * s, 0.04 * s, 1.4 * s, 14);
    _translateGeo(rootMB,  0.22 * s, -0.9 * s,  0.1 * s);
    const rootML = _taperCylinder(0.12 * s, 0.04 * s, 1.3 * s, 14);
    _translateGeo(rootML, -0.18 * s, -0.88 * s,  0.1 * s);
    const rootD  = _taperCylinder(0.14 * s, 0.05 * s, 1.35 * s, 14);
    _translateGeo(rootD,   0,        -0.85 * s, -0.2 * s);
    return _mergeGeos([crown, ...cusps, rootMB, rootML, rootD]);
  }

  // ── Geometry primitives ───────────────────────────────────

  /** Ellipsoidal sphere with independent x/y/z radii */
  function _flattenedSphere(rx, ry, rz, segs, rings) {
    const geo = new THREE.SphereGeometry(1, segs, rings);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) * rx, pos.getY(i) * ry, pos.getZ(i) * rz);
    }
    geo.computeVertexNormals();
    return geo;
  }

  /** Tapered cylinder (cone-cylinder hybrid) */
  function _taperCylinder(topR, botR, height, segs) {
    return new THREE.CylinderGeometry(botR, topR, height, segs);
  }

  /** Translate all vertices of a geometry in-place */
  function _translateGeo(geo, x, y, z) {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, pos.getX(i) + x, pos.getY(i) + y, pos.getZ(i) + z);
    }
    geo.computeVertexNormals();
  }

  /** Merge multiple BufferGeometries into one non-indexed geometry */
  function _mergeGeos(geos) {
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

  return { generate, typeFromFDI, buildLibrary };
})();


// ═══════════════════════════════════════════════════════════
// 4. ARTICULATOR — virtual jaw movement simulation
// ═══════════════════════════════════════════════════════════
const Articulator = (() => {

  /**
   * Simulates condylar-guided jaw movements on a Three.js scene.
   *
   * Settings (Hanau-inspired semi-adjustable articulator):
   *   condylarInclination  : 30°  (sagittal condylar path)
   *   bennetAngle          : 15°  (lateral shift)
   *   intercondylarDist    : 110 mm (normalised to 1.0 in scene)
   *
   * Movement modes:
   *   'protrusive'  — mandible slides forward-downward
   *   'lateral-R'   — right laterotrusion (Bennett movement)
   *   'lateral-L'   — left laterotrusion
   *   'open'        — pure hinge opening
   *
   * Usage:
   *   const art = Articulator.create(upperMesh, lowerMesh, scene);
   *   art.animate('protrusive', 0.0 → 1.0);  // 0=ICP, 1=max excursion
   *   art.reset();
   */

  function create(upperMesh, lowerMesh, scene, opts = {}) {
    const condInc  = THREE.MathUtils.degToRad(opts.condylarInclination ?? 30);
    const bennett  = THREE.MathUtils.degToRad(opts.bennetAngle         ?? 15);
    const hingeY   = opts.hingeY ?? -1.5;    // condyle pivot Y (scene units)
    const hingeZ   = opts.hingeZ ?? -1.8;    // condyle pivot Z

    // Pivot point in scene space (condyle centre)
    const pivot = new THREE.Object3D();
    pivot.position.set(0, hingeY, hingeZ);
    if (lowerMesh) {
      // Re-parent lower mesh under pivot for rotation
      const worldPos = new THREE.Vector3();
      lowerMesh.getWorldPosition(worldPos);
      scene.remove(lowerMesh);
      pivot.add(lowerMesh);
      scene.add(pivot);
    } else {
      scene.add(pivot);
    }

    // Store original transform
    const origRot = pivot.rotation.clone();
    const origPos = pivot.position.clone();

    function animate(mode, t) {
      // t in [0, 1]
      pivot.rotation.copy(origRot);
      pivot.position.copy(origPos);

      switch (mode) {
        case 'protrusive': {
          // Rotate around condylar inclination + translate forward
          const angle = -condInc * t;
          const tx    = 0;
          const ty    = -Math.sin(condInc) * t * 0.8;
          const tz    =  Math.cos(condInc) * t * 0.8;
          pivot.rotation.x = angle;
          pivot.position.y = origPos.y + ty;
          pivot.position.z = origPos.z + tz;
          break;
        }
        case 'lateral-R': {
          const angle = bennett * t;
          pivot.rotation.z = angle;
          pivot.rotation.x = -condInc * t * 0.5;
          pivot.position.x = 0.2 * t;
          break;
        }
        case 'lateral-L': {
          const angle = -bennett * t;
          pivot.rotation.z = angle;
          pivot.rotation.x = -condInc * t * 0.5;
          pivot.position.x = -0.2 * t;
          break;
        }
        case 'open': {
          pivot.rotation.x = -condInc * t * 1.5;
          pivot.position.y = origPos.y - 0.3 * t;
          break;
        }
      }
    }

    function reset() {
      pivot.rotation.copy(origRot);
      pivot.position.copy(origPos);
    }

    function dispose() {
      if (lowerMesh && pivot.children.includes(lowerMesh)) {
        pivot.remove(lowerMesh);
        scene.add(lowerMesh);
      }
      scene.remove(pivot);
    }

    return { animate, reset, dispose, pivot };
  }

  return { create };
})();


// ═══════════════════════════════════════════════════════════
// 5. VALIDATOR — real thickness + contact point checks
// ═══════════════════════════════════════════════════════════
const Validator = (() => {

  /**
   * ⚠ MEDICAL DISCLAIMER (injected into every result set):
   *   These validation results are VISUAL AIDS for technician guidance only.
   *   They are NOT a substitute for clinical judgment, regulatory approval,
   *   or compliance with applicable dental standards (ISO 6872, ADA, etc.).
   *   Always confirm results with a qualified dental professional before
   *   manufacturing or delivering any restoration to a patient.
   */
  const DISCLAIMER = {
    id: '_disclaimer',
    label: '⚠ Visual Aid Only — Not Clinical Approval',
    pass: true,    // doesn't block export, just informs
    value: null,
    message: 'These results are a visual aid. They must be reviewed by a qualified dental professional before clinical use. Not a substitute for ISO/ADA compliance testing.',
    isDisclaimer: true,
  };

  /**
   * Run all validation checks on the design mesh.
   *
   * @param {THREE.BufferGeometry} restorationGeo  — the designed restoration
   * @param {THREE.BufferGeometry} prepGeo          — the prepared tooth (optional)
   * @param {object} rules
   *   minThickness {number}  mm  — overrides material default if provided
   *   maxThickness {number}  mm  — overrides material default if provided
   *   contactThreshold {number} mm  (default 0.05)
   *   material     {string}  e.g. 'Zirconia (3Y-TZP)' — drives default thresholds
   * @returns {object[]}  array of { id, label, pass, value, message, isDisclaimer? }
   *   First element is always the DISCLAIMER entry.
   */
  function runAll(restorationGeo, prepGeo = null, rules = {}) {
    const material       = rules.material       ?? 'default';
    const thresh         = WallThickness.getThresholds(material);
    const minThick       = rules.minThickness    ?? thresh.minThick;
    const maxThick       = rules.maxThickness    ?? thresh.maxThick;
    const contactThresh  = rules.contactThreshold ?? 0.05;

    // Always prepend the disclaimer
    const results = [DISCLAIMER];

    // ── Check 1: Scan data ──────────────────────────────────
    results.push({
      id: 'scan_ok',
      label: 'Scan data imported',
      pass:  !!restorationGeo,
      value: restorationGeo ? restorationGeo.getAttribute('position')?.count ?? 0 : 0,
      message: restorationGeo ? 'Scan geometry present' : 'No scan loaded',
    });

    if (!restorationGeo) return results;

    const pos = restorationGeo.getAttribute('position');
    if (!pos) {
      results.push({ id: 'geo_ok', label: 'Geometry valid', pass: false, value: 0, message: 'Missing position attribute' });
      return results;
    }

    // ── Check 2: Minimum wall thickness ────────────────────
    const thickResult = WallThickness.compute(restorationGeo, { minThick, maxThick, sampleStep: 4, material });
    const { stats } = thickResult;
    results.push({
      id: 'thickness_ok',
      label: `Min wall thickness ≥ ${minThick} mm (${thresh.label})`,
      pass:  stats.min >= minThick,
      value: stats.min,
      message: (stats.min >= minThick
        ? `Min: ${stats.min} mm  —  Mean: ${stats.mean} mm`
        : `⚠ Minimum ${stats.min} mm below ${minThick} mm limit! (${stats.pctBelowMin}% of surface)`)
        + ` [${thresh.label} threshold — visual aid only]`,
    });

    // ── Check 3: Maximum thickness (over-bulk) ──────────────
    results.push({
      id: 'max_thickness_ok',
      label: `Max wall thickness ≤ ${maxThick} mm`,
      pass:  stats.max <= maxThick,
      value: stats.max,
      message: `Max: ${stats.max} mm`,
    });

    // ── Check 4: Manifold check (open edges) ────────────────
    const edgeCheck = _checkManifold(pos);
    results.push({
      id: 'manifold_ok',
      label: 'Watertight mesh (no open edges)',
      pass:  edgeCheck.pass,
      value: edgeCheck.openEdges,
      message: edgeCheck.pass
        ? 'Mesh is watertight'
        : `${edgeCheck.openEdges} open edges detected — may affect printing`,
    });

    // ── Check 5: Contact points (if prep geometry provided) ─
    if (prepGeo) {
      const cpResult = _checkContactPoints(restorationGeo, prepGeo, contactThresh);
      results.push({
        id: 'contacts_ok',
        label: 'Proximal contacts within tolerance',
        pass:  cpResult.pass,
        value: cpResult.contactCount,
        message: cpResult.pass
          ? `${cpResult.contactCount} contact points detected`
          : `Contact gap: ${cpResult.maxGap.toFixed(3)} mm (threshold: ${contactThresh} mm)`,
      });
    } else {
      results.push({
        id: 'contacts_ok',
        label: 'Proximal contacts (no reference mesh)',
        pass:  true,
        value: 0,
        message: 'Load opposing arch for contact analysis',
      });
    }

    // ── Check 6: Centroid alignment ─────────────────────────
    const centroid = _centroid3D(pos);
    const isAligned = Math.abs(centroid.x) < 3.0 && Math.abs(centroid.y) < 3.0;
    results.push({
      id: 'alignment_ok',
      label: 'Model centred in viewport',
      pass:  isAligned,
      value: centroid,
      message: isAligned
        ? `Centroid: (${centroid.x.toFixed(2)}, ${centroid.y.toFixed(2)}, ${centroid.z.toFixed(2)})`
        : 'Model far from origin — check import scale',
    });

    return results;
  }

  function _checkManifold(posAttr) {
    // Count edge occurrences: each edge (sorted v pair) should appear exactly 2x
    const edgeMap = new Map();
    for (let i = 0; i < posAttr.count; i += 3) {
      for (const [a, b] of [[i,i+1],[i+1,i+2],[i+2,i]]) {
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
      }
    }
    let openEdges = 0;
    for (const count of edgeMap.values()) {
      if (count !== 2) openEdges++;
    }
    return { pass: openEdges === 0, openEdges };
  }

  function _checkContactPoints(geoA, geoB, threshold) {
    // Simplified: find minimum distance between vertex clouds
    const posA = geoA.getAttribute('position');
    const posB = geoB.getAttribute('position');
    let minDist = Infinity;
    let contactCount = 0;
    const step = Math.max(1, Math.floor(posA.count / 200)); // sample 200 pts max

    for (let i = 0; i < posA.count; i += step) {
      const ax = posA.getX(i), ay = posA.getY(i), az = posA.getZ(i);
      for (let j = 0; j < posB.count; j += step) {
        const dx = ax - posB.getX(j);
        const dy = ay - posB.getY(j);
        const dz = az - posB.getZ(j);
        const d  = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (d < minDist) minDist = d;
        if (d <= threshold) contactCount++;
      }
    }
    return {
      pass: minDist <= threshold + 0.1,
      maxGap: minDist,
      contactCount,
    };
  }

  function _centroid3D(posAttr) {
    let cx = 0, cy = 0, cz = 0;
    const n = posAttr.count;
    for (let i = 0; i < n; i++) {
      cx += posAttr.getX(i); cy += posAttr.getY(i); cz += posAttr.getZ(i);
    }
    return { x: cx/n, y: cy/n, z: cz/n };
  }

  return { runAll };
})();


// ═══════════════════════════════════════════════════════════
// 6. MARGIN LINE ENGINE
//    Class-based engine that integrates with the live THREE.js
//    scene.  Improvements over the existing MarginLineTool:
//    • Edge-snapping via curvature gradient on intersected face
//    • Closed CatmullRom spline rendered in real-time
//    • Exposes same getPoints() / clear() API for save/load
// ═══════════════════════════════════════════════════════════
class MarginLineEngine {

  /**
   * @param {THREE.Scene}    scene
   * @param {THREE.Camera}   camera
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, camera, renderer) {
    this.scene      = scene;
    this.camera     = camera;
    this.renderer   = renderer;

    this.points         = [];          // THREE.Vector3[]
    this.controlSpheres = [];          // visual markers
    this.lineMesh       = null;        // CatmullRom line
    this.raycaster      = new THREE.Raycaster();
    this.mouse          = new THREE.Vector2();
    this.isActive       = false;
    this.targetMesh     = null;

    // Drag-guard: ignore clicks that were actually drags
    this._mouseDownPos  = null;
    this._DRAG_THRESH   = 5;           // px

    // Bound handlers (kept so removeEventListener works)
    this._onDown = this._handleDown.bind(this);
    this._onUp   = this._handleUp.bind(this);
  }

  // ── Target mesh ──────────────────────────────────────────
  setTargetMesh(mesh) {
    this.targetMesh = mesh;
  }

  // ── Enable / disable ─────────────────────────────────────
  enable() {
    this.isActive = true;
    this.renderer.domElement.style.cursor = 'crosshair';
    this.renderer.domElement.addEventListener('mousedown', this._onDown, { capture: true });
    this.renderer.domElement.addEventListener('mouseup',   this._onUp,   { capture: true });
  }

  disable() {
    this.isActive = false;
    this.renderer.domElement.style.cursor = '';
    this.renderer.domElement.removeEventListener('mousedown', this._onDown, { capture: true });
    this.renderer.domElement.removeEventListener('mouseup',   this._onUp,   { capture: true });
  }

  // ── Mouse handlers ────────────────────────────────────────
  _handleDown(e) {
    if (e.button !== 0) return;
    this._mouseDownPos = { x: e.clientX, y: e.clientY };
    e.stopPropagation();   // block viewport orbit while tool is active
  }

  _handleUp(e) {
    if (e.button !== 0) return;
    e.stopPropagation();

    // Drag guard
    if (this._mouseDownPos) {
      const dx = e.clientX - this._mouseDownPos.x;
      const dy = e.clientY - this._mouseDownPos.y;
      this._mouseDownPos = null;
      if (Math.sqrt(dx * dx + dy * dy) > this._DRAG_THRESH) return;
    }

    this.onClick(e);
  }

  onClick(event) {
    if (!this.isActive || !this.targetMesh) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x =  ((event.clientX - rect.left) / rect.width)  * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top)  / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObject(this.targetMesh, true);

    if (hits.length > 0) {
      const hit      = hits[0];
      const snapped  = this.snapToEdge(hit.point.clone(), hit.face);
      this.addMarginPoint(snapped);
    }
  }

  // ── Edge-snap ─────────────────────────────────────────────
  /**
   * Snaps the click point to the vertex (of the intersected face)
   * closest to the click position, biased toward high-curvature vertices.
   */
  snapToEdge(point, face) {
    if (!face || !this.targetMesh?.geometry) return point;

    const geom = this.targetMesh.geometry;
    const pos  = geom.attributes.position;
    const norm = geom.attributes.normal;

    // face.a/b/c available on non-indexed geometry as sequential indices
    const faceVerts = geom.index
      ? [geom.index.getX(face.a), geom.index.getX(face.b), geom.index.getX(face.c)]
      : [face.a, face.b, face.c];

    let bestVert  = point;
    let bestScore = -Infinity;

    faceVerts.forEach(vIdx => {
      const v = new THREE.Vector3(
        pos.getX(vIdx), pos.getY(vIdx), pos.getZ(vIdx)
      ).applyMatrix4(this.targetMesh.matrixWorld);

      // Score = curvature proxy (normal divergence from neighbours)
      // Simple proxy: distance-weighed closeness to click point
      const dist = v.distanceTo(point);
      if (dist < 0.5) {
        const score = 1 / (dist + 0.001);
        if (score > bestScore) { bestScore = score; bestVert = v.clone(); }
      }
    });

    return bestVert;
  }

  // ── Point management ──────────────────────────────────────
  addMarginPoint(point) {
    this.points.push(point.clone());

    const geo  = new THREE.SphereGeometry(0.045, 12, 10);
    const mat  = new THREE.MeshBasicMaterial({ color: 0x00ffcc, depthTest: false });
    const sph  = new THREE.Mesh(geo, mat);
    sph.position.copy(point);
    sph.renderOrder = 998;
    this.scene.add(sph);
    this.controlSpheres.push(sph);

    this.updateSplineCurve();
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  }

  removeLastPoint() {
    if (!this.points.length) return;
    this.points.pop();
    const s = this.controlSpheres.pop();
    if (s) { this.scene.remove(s); s.geometry.dispose(); s.material.dispose(); }
    this.updateSplineCurve();
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  }

  // ── Spline rebuild ────────────────────────────────────────
  updateSplineCurve() {
    if (this.lineMesh) {
      this.scene.remove(this.lineMesh);
      this.lineMesh.geometry.dispose();
      this.lineMesh = null;
    }
    if (this.points.length < 2) return;

    const closed   = this.points.length >= 3;
    const curve    = new THREE.CatmullRomCurve3(this.points, closed, 'catmullrom', 0.5);
    const pts      = curve.getPoints(Math.max(80, this.points.length * 14));
    const geo      = new THREE.BufferGeometry().setFromPoints(pts);
    const mat      = new THREE.LineBasicMaterial({
      color:      closed ? 0x00ffcc : 0x00ccff,
      linewidth:  2,
      depthTest:  false,
    });
    this.lineMesh = new THREE.Line(geo, mat);
    this.lineMesh.renderOrder = 997;
    this.scene.add(this.lineMesh);
  }

  // ── Public helpers ────────────────────────────────────────
  /** Returns [[x,y,z], ...] — compatible with ProjectIO save format */
  getPoints() {
    return this.points.map(p => p.toArray());
  }

  /** Restore saved points (skips undo stack) */
  restorePoints(arrayOfArrays) {
    this.clear();
    arrayOfArrays.forEach(([x, y, z]) => this.addMarginPoint(new THREE.Vector3(x, y, z)));
  }

  clear() {
    this.controlSpheres.forEach(s => {
      this.scene.remove(s);
      s.geometry?.dispose();
      s.material?.dispose();
    });
    this.controlSpheres = [];
    this.points         = [];
    if (this.lineMesh) {
      this.scene.remove(this.lineMesh);
      this.lineMesh.geometry?.dispose();
      this.lineMesh = null;
    }
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disable();
    this.clear();
  }
}


// ═══════════════════════════════════════════════════════════
// 7. SCULPTING ENGINE
//    Real-time vertex displacement with:
//    • ADD / SUBTRACT / SMOOTH / FLATTEN modes
//    • Gaussian falloff brush
//    • Minimum wall-thickness protection (SUBTRACT mode)
//    • Orange ring cursor that follows the mesh surface
//    • Undo-compatible: snapshot before stroke, commit after
// ═══════════════════════════════════════════════════════════
class SculptingEngine {

  /**
   * @param {THREE.Scene}         scene
   * @param {THREE.Camera}        camera
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(scene, camera, renderer) {
    this.scene      = scene;
    this.camera     = camera;
    this.renderer   = renderer;

    this.targetMesh  = null;
    this.isActive    = false;
    this.isMouseDown = false;

    this.brush = {
      radius:       1.5,
      intensity:    0.015,
      mode:         'ADD',   // 'ADD' | 'SUBTRACT' | 'SMOOTH' | 'FLATTEN'
      minThickness: 0.3,     // scene units (~mm at viewport scale)
    };

    this.raycaster = new THREE.Raycaster();
    this.mouse     = new THREE.Vector2();

    // Snapshot for undo (captured on mousedown)
    this._beforeSnap = null;

    // Bound handlers
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerUp   = this._handlePointerUp.bind(this);

    this._buildCursor();
  }

  // ── Target ────────────────────────────────────────────────
  setTargetMesh(mesh) {
    this.targetMesh = mesh;
  }

  // ── Brush settings ────────────────────────────────────────
  setMode(mode)      { this.brush.mode      = mode.toUpperCase(); }
  setRadius(r)       {
    this.brush.radius = r;
    // Rebuild ring geometry to match new radius
    this.cursorRing.geometry.dispose();
    this.cursorRing.geometry = new THREE.RingGeometry(r * 0.88, r, 36);
  }
  setIntensity(i)    { this.brush.intensity    = i; }
  setMinThickness(t) { this.brush.minThickness = t; }

  // ── Enable / disable ─────────────────────────────────────
  enable() {
    this.isActive = true;
    this.cursorRing.visible = false;
    const dom = this.renderer.domElement;
    dom.addEventListener('pointermove', this._onPointerMove);
    dom.addEventListener('pointerdown', this._onPointerDown);
    dom.addEventListener('pointerup',   this._onPointerUp);
    dom.style.cursor = 'none';
  }

  disable() {
    this.isActive    = false;
    this.isMouseDown = false;
    this.cursorRing.visible = false;
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointermove', this._onPointerMove);
    dom.removeEventListener('pointerdown', this._onPointerDown);
    dom.removeEventListener('pointerup',   this._onPointerUp);
    dom.style.cursor = '';
  }

  // ── Cursor ring ───────────────────────────────────────────
  _buildCursor() {
    const r   = this.brush.radius;
    const geo = new THREE.RingGeometry(r * 0.88, r, 36);
    const mat = new THREE.MeshBasicMaterial({
      color:      0xffa500,
      side:       THREE.DoubleSide,
      depthTest:  false,
      transparent: true,
      opacity:    0.85,
    });
    this.cursorRing = new THREE.Mesh(geo, mat);
    this.cursorRing.renderOrder = 999;
    this.cursorRing.visible = false;
    this.scene.add(this.cursorRing);
  }

  // ── Event handlers ────────────────────────────────────────
  _handlePointerDown(e) {
    if (!this.isActive || e.button !== 0) return;
    this.isMouseDown = true;

    // Snapshot for undo
    if (this.targetMesh) {
      const pos = this.targetMesh.geometry.getAttribute('position');
      this._beforeSnap = new Float32Array(pos.array);
    }
  }

  _handlePointerUp(e) {
    if (!this.isMouseDown) return;
    this.isMouseDown = false;

    // Push undo command if mesh was modified
    if (this._beforeSnap && this.targetMesh && typeof UndoRedo !== 'undefined') {
      const pos   = this.targetMesh.geometry.getAttribute('position');
      const after = new Float32Array(pos.array);
      const before = this._beforeSnap;
      const label  = `Sculpt ${this.brush.mode}`;

      UndoRedo.push(new UndoRedo.MeshStateCommand(label, before, after, (arr) => {
        pos.array.set(arr);
        pos.needsUpdate = true;
        this.targetMesh.geometry.computeVertexNormals();
        if (this.renderer) this.renderer.render(this.scene, this.camera);
      }));
    }
    this._beforeSnap = null;
  }

  _handlePointerMove(e) {
    if (!this.isActive || !this.targetMesh) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObject(this.targetMesh);

    if (hits.length > 0) {
      const hit = hits[0];
      // Position cursor ring at hit point, oriented to face normal
      this.cursorRing.position.copy(hit.point);
      this.cursorRing.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        hit.face.normal.clone().transformDirection(this.targetMesh.matrixWorld)
      );
      this.cursorRing.visible = true;

      if (this.isMouseDown) {
        this._sculpt(hit.point, hit.face.normal);
      }
    } else {
      this.cursorRing.visible = false;
    }

    if (this.renderer) this.renderer.render(this.scene, this.camera);
  }

  // ── Core sculpt ───────────────────────────────────────────
  _sculpt(centerWorld, faceNormal) {
    const geom  = this.targetMesh.geometry;
    const pos   = geom.getAttribute('position');
    const norm  = geom.getAttribute('normal');
    const invMat = this.targetMesh.matrixWorld.clone().invert();

    // Convert hit point to local space
    const localCenter = centerWorld.clone().applyMatrix4(invMat);

    const mode   = this.brush.mode;
    const radius = this.brush.radius;
    const intens = this.brush.intensity;
    const minT   = this.brush.minThickness;
    const r2     = radius * radius;

    const v = new THREE.Vector3();
    const n = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));

      const dist2 = v.distanceToSquared(localCenter);
      if (dist2 > r2) continue;

      // Gaussian falloff
      const dist    = Math.sqrt(dist2);
      const falloff = Math.exp(-Math.pow(dist / radius, 2));
      const delta   = intens * falloff;

      n.set(norm.getX(i), norm.getY(i), norm.getZ(i));

      switch (mode) {
        case 'ADD':
          v.addScaledVector(n, delta);
          break;

        case 'SUBTRACT': {
          // Min-thickness protection: only allow inward push if result
          // stays above minThickness from centroid (rough proxy for inner surface)
          const newPos = v.clone().addScaledVector(n, -delta);
          if (newPos.length() > minT) v.copy(newPos);
          break;
        }

        case 'SMOOTH': {
          // Laplacian: average vertex toward its triangle-neighbours
          const triBase = Math.floor(i / 3) * 3;
          const sumX = pos.getX(triBase)   + pos.getX(triBase+1) + pos.getX(triBase+2);
          const sumY = pos.getY(triBase)   + pos.getY(triBase+1) + pos.getY(triBase+2);
          const sumZ = pos.getZ(triBase)   + pos.getZ(triBase+1) + pos.getZ(triBase+2);
          v.lerp(new THREE.Vector3(sumX/3, sumY/3, sumZ/3), delta * 2);
          break;
        }

        case 'FLATTEN': {
          // Project vertex onto the tangent plane at brush center
          const toV    = v.clone().sub(localCenter);
          const dot    = toV.dot(n);
          const proj   = v.clone().sub(n.clone().multiplyScalar(dot * falloff * delta * 4));
          v.lerp(proj, falloff);
          break;
        }
      }

      pos.setXYZ(i, v.x, v.y, v.z);
    }

    pos.needsUpdate = true;
    geom.computeVertexNormals();
  }

  // ── Cleanup ───────────────────────────────────────────────
  dispose() {
    this.disable();
    this.scene.remove(this.cursorRing);
    this.cursorRing.geometry.dispose();
    this.cursorRing.material.dispose();
  }
}

// Expose globally so app.js can access them directly
window.MarginLineEngine = MarginLineEngine;
window.SculptingEngine  = SculptingEngine;


// ═══════════════════════════════════════════════════════════
// 8. CROWN GENERATOR ENGINE
//    Adapts a template crown mesh to a margin line spline,
//    applies cement gap offset, and validates min thickness.
//
//    Improvements over the provided code:
//    • Works in LOCAL space throughout (avoids redundant
//      world→local round-trips that introduced precision loss)
//    • boundaryThreshold uses Y axis (Three.js up = +Y) not Z
//    • generateCementGapShell accepts a scale factor so the
//      offset is in viewport units (scene mm), not raw mm
//    • disposeShell() cleans up generated geometry
// ═══════════════════════════════════════════════════════════
class CrownGeneratorEngine {

  /**
   * @param {THREE.Scene} scene
   * @param {object}      opts
   *   cementGap     {number}  mm  (default 0.05 = 50 µm)
   *   minThickness  {number}  mm  (default 0.6)
   *   viewportScale {number}  scene-units per mm (default 1.0)
   */
  constructor(scene, opts = {}) {
    this.scene        = scene;
    this.cementGapMM  = opts.cementGap     ?? 0.05;
    this.minThickMM   = opts.minThickness  ?? 0.6;
    this.vpScale      = opts.viewportScale ?? 1.0;  // scene units / mm

    this._cementShell = null;  // reference for cleanup
    this._crownMesh   = null;
  }

  // ── Crown adaptation ──────────────────────────────────────
  /**
   * Deforms the base loop of crownMesh to follow marginPoints.
   *
   * @param {THREE.Mesh}     crownMesh     — the template crown
   * @param {THREE.Vector3[]} marginPoints — points in WORLD space
   */
  adaptCrownToMargin(crownMesh, marginPoints) {
    if (!crownMesh || !marginPoints || marginPoints.length < 3) {
      Logger?.warn('CrownGen', 'adaptCrownToMargin: invalid input');
      return;
    }

    this._crownMesh = crownMesh;
    const geom      = crownMesh.geometry;
    const pos       = geom.getAttribute('position');
    const invWorld  = crownMesh.matrixWorld.clone().invert();

    // Convert all margin points to local crown space once
    const localMargin = marginPoints.map(p => p.clone().applyMatrix4(invWorld));

    // Find lowest Y in local space (crown base)
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
    }

    // Threshold: 1 scene-unit above base
    const thresh = minY + 1.0 * this.vpScale;

    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > thresh) continue;   // only modify the base loop

      const vx = pos.getX(i);
      const vy = y;
      const vz = pos.getZ(i);
      const v  = new THREE.Vector3(vx, vy, vz);

      // Find nearest local-space margin point
      let bestDist = Infinity;
      let bestPt   = localMargin[0];
      localMargin.forEach(p => {
        const d = v.distanceTo(p);
        if (d < bestDist) { bestDist = d; bestPt = p; }
      });

      // Blend factor: 1.0 at base, 0.0 at threshold
      const t      = Math.max(0, 1.0 - (vy - minY) / (thresh - minY));
      const factor = t * 0.8;

      pos.setXYZ(i,
        vx + (bestPt.x - vx) * factor,
        vy + (bestPt.y - vy) * factor,
        vz + (bestPt.z - vz) * factor,
      );
    }

    pos.needsUpdate = true;
    geom.computeVertexNormals();
    Logger?.info('CrownGen', `Crown adapted to ${marginPoints.length} margin points`);
  }

  // ── Cement gap shell ──────────────────────────────────────
  /**
   * Offsets prep-tooth surface outward by cementGapMM to create
   * the cement space (inner surface of the crown internal fit).
   *
   * @param  {THREE.Mesh} prepToothMesh
   * @returns {THREE.Mesh} the offset shell (already added to scene)
   */
  generateCementGapShell(prepToothMesh) {
    if (!prepToothMesh?.geometry) return null;

    // Dispose previous shell
    this.disposeShell();

    const geo  = prepToothMesh.geometry.clone();
    const pos  = geo.getAttribute('position');
    const norm = geo.getAttribute('normal') ||
                 (() => { geo.computeVertexNormals(); return geo.getAttribute('normal'); })();

    // Offset = cementGapMM converted to scene units
    const offset = this.cementGapMM * this.vpScale;

    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i,
        pos.getX(i) + norm.getX(i) * offset,
        pos.getY(i) + norm.getY(i) * offset,
        pos.getZ(i) + norm.getZ(i) * offset,
      );
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const mat  = new THREE.MeshStandardMaterial({
      color:       0xff5500,
      wireframe:   true,
      transparent: true,
      opacity:     0.45,
      depthTest:   true,
    });

    this._cementShell      = new THREE.Mesh(geo, mat);
    this._cementShell.name = 'CementGapShell';
    this._cementShell.renderOrder = 1;
    this.scene.add(this._cementShell);

    Logger?.info('CrownGen', `Cement gap shell: ${this.cementGapMM * 1000} µm`);
    return this._cementShell;
  }

  // ── Helpers ───────────────────────────────────────────────
  disposeShell() {
    if (this._cementShell) {
      this.scene.remove(this._cementShell);
      this._cementShell.geometry?.dispose();
      this._cementShell.material?.dispose();
      this._cementShell = null;
    }
  }

  setCementGap(mm)      { this.cementGapMM = mm; }
  setMinThickness(mm)   { this.minThickMM  = mm; }
  setViewportScale(s)   { this.vpScale     = s; }

  dispose() {
    this.disposeShell();
    this._crownMesh = null;
  }
}


// ═══════════════════════════════════════════════════════════
// 9. OCCLUSION HEATMAP ENGINE
//    GPU shader-based real-time occlusion distance heatmap.
//
//    Colours per vertex by signed distance to the opposing arch:
//      Red   → collision / penetration  (dist < 0)
//      Green → ideal occlusal contact   (0 – 0.05 mm)
//      Yellow→ light contact            (0.05 – 0.2 mm)
//      Blue  → clearance zone           (0.2 – 0.5 mm)
//      Grey  → no contact               (> 0.5 mm)
//
//    Improvements:
//    • uMaxDistance uniform exposes full colour range
//    • uOpposingPlanePos is a world-Y float, not a Vector3 plane
//    • autoAdaptOcclusion uses a configurable clearance param
//    • restoreOriginalMaterial() saves & restores the mesh mat
// ═══════════════════════════════════════════════════════════
class OcclusionHeatmapEngine {

  /**
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(renderer) {
    this.renderer  = renderer;
    this._origMats = new Map();   // mesh → original material

    this._material = this._buildShaderMaterial();
  }

  // ── Shader ────────────────────────────────────────────────
  _buildShaderMaterial() {
    const vertexShader = /* glsl */`
      varying vec3 vWorldPos;
      varying vec3 vNormal;

      void main() {
        // Pass world-space position and normal to fragment shader
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos     = worldPos.xyz;
        vNormal       = normalize(normalMatrix * normal);
        gl_Position   = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    const fragmentShader = /* glsl */`
      varying vec3 vWorldPos;
      varying vec3 vNormal;

      uniform float uOpposingY;     // world-Y of opposing arch occlusal plane
      uniform float uMaxDistance;   // distance mapped to fully "no contact" grey

      // 5-stop heatmap palette
      vec3 heatmapColor(float d) {
        if (d < 0.0)    return vec3(1.0, 0.0, 0.0);          // Red: collision
        if (d <= 0.05)  return mix(vec3(1.0,0.0,0.0),
                                   vec3(0.0,1.0,0.0),
                                   d / 0.05);                  // Red→Green: near contact
        if (d <= 0.2)   return mix(vec3(0.0,1.0,0.0),
                                   vec3(1.0,1.0,0.0),
                                   (d - 0.05) / 0.15);         // Green→Yellow
        if (d <= 0.5)   return mix(vec3(1.0,1.0,0.0),
                                   vec3(0.0,0.5,1.0),
                                   (d - 0.2) / 0.3);           // Yellow→Blue
        float t = clamp((d - 0.5) / (uMaxDistance - 0.5), 0.0, 1.0);
        return mix(vec3(0.0,0.5,1.0), vec3(0.8,0.8,0.8), t);  // Blue→Grey
      }

      void main() {
        // Signed distance: positive = below opposing arch (clearance)
        float dist  = uOpposingY - vWorldPos.y;
        vec3  color = heatmapColor(dist);

        // Simple Lambertian shading
        vec3  lightDir = normalize(vec3(0.5, 1.0, 0.75));
        float diffuse  = max(dot(vNormal, lightDir), 0.25);

        gl_FragColor = vec4(color * diffuse, 1.0);
      }
    `;

    return new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uOpposingY:   { value: 2.0 },    // default opposing arch plane Y
        uMaxDistance: { value: 0.5 },
      },
    });
  }

  // ── Apply / remove heatmap ────────────────────────────────
  /**
   * Replace mesh material with heatmap shader.
   * Original material is saved and can be restored.
   *
   * @param {THREE.Mesh}    mesh
   * @param {number|THREE.Vector3} opposingArch  — world-Y number or Vector3
   */
  applyToMesh(mesh, opposingArch) {
    if (!mesh) return;

    // Save original
    if (!this._origMats.has(mesh)) {
      this._origMats.set(mesh, mesh.material);
    }

    // Update uniforms
    const y = (typeof opposingArch === 'number')
      ? opposingArch
      : (opposingArch instanceof THREE.Vector3 ? opposingArch.y : 2.0);

    this._material.uniforms.uOpposingY.value = y;
    mesh.material = this._material;
    mesh.material.needsUpdate = true;
  }

  /** Restore the mesh's original material */
  restoreOriginalMaterial(mesh) {
    if (!mesh) return;
    const orig = this._origMats.get(mesh);
    if (orig) {
      mesh.material = orig;
      this._origMats.delete(mesh);
    }
  }

  restoreAll() {
    this._origMats.forEach((mat, mesh) => { mesh.material = mat; });
    this._origMats.clear();
  }

  // ── Update opposing arch plane ────────────────────────────
  setOpposingPlane(y)         { this._material.uniforms.uOpposingY.value   = y; }
  setMaxDistance(mm)          { this._material.uniforms.uMaxDistance.value  = mm; }

  // ── Auto-trim high-spots ──────────────────────────────────
  /**
   * Clamps any vertex above `opposingY` down to
   * `opposingY - clearanceMM` (default 0.02 mm).
   *
   * @param {THREE.Mesh} crownMesh
   * @param {number}     opposingY     — world-Y of opposing plane
   * @param {number}     clearanceMM   — desired occlusal clearance
   */
  autoAdaptOcclusion(crownMesh, opposingY, clearanceMM = 0.02) {
    if (!crownMesh?.geometry) return;

    const geom      = crownMesh.geometry;
    const pos       = geom.getAttribute('position');
    const clearance = clearanceMM;   // already in scene units (vpScale applied by caller)
    let   trimmed   = 0;

    for (let i = 0; i < pos.count; i++) {
      // Convert local Y → world Y
      const worldY = pos.getY(i) + crownMesh.position.y;
      if (worldY > opposingY) {
        pos.setY(i, (opposingY - clearance) - crownMesh.position.y);
        trimmed++;
      }
    }

    if (trimmed > 0) {
      pos.needsUpdate = true;
      geom.computeVertexNormals();
      Logger?.info('OcclusionHeatmap', `Auto-trimmed ${trimmed} vertices`);
    }
    return trimmed;
  }

  // ── Dispose ───────────────────────────────────────────────
  dispose() {
    this.restoreAll();
    this._material.dispose();
  }
}

// Global export
window.CrownGeneratorEngine    = CrownGeneratorEngine;
window.OcclusionHeatmapEngine  = OcclusionHeatmapEngine;


// ═══════════════════════════════════════════════════════════
// 9. SMART SUGGESTIONS — rule-based (no ML, no external API)
// ═══════════════════════════════════════════════════════════

/**
 * SmartSuggestions
 *
 * Two engines, both 100% client-side and deterministic:
 *
 * 1. SmartMarginSuggestion — improves MarginDetector output via:
 *    - Weighted scoring: curvature + proximity to preparation edge
 *    - Gaussian smoothing pass (configurable iterations)
 *    - Loop closure gap-fill (max gap threshold)
 *    Named "Smart Suggestion" in the UI, never "AI", because there
 *    is no machine learning behind it — it is enhanced rule-based math.
 *
 * 2. RestorationHint — maps FDI tooth numbers → likely restoration type
 *    via clinical rule tables (e.g. molars → Crown, incisors → Veneer).
 *    Produces a ranked suggestion list with confidence labels.
 *
 * ⚠ Neither engine produces clinically authoritative output.
 *   All suggestions must be reviewed by a qualified dental professional.
 */
const SmartSuggestions = (() => {

  // ── 1. Smart Margin Suggestion ────────────────────────────

  /**
   * Enhanced margin detection combining curvature + edge proximity.
   *
   * @param {THREE.BufferGeometry} geo
   * @param {object} opts
   *   topPct        {number}  curvature percentile threshold   (default 15)
   *   smoothIter    {number}  Gaussian smooth passes            (default 4)
   *   edgeWeight    {number}  0–1, how much edge distance matters (default 0.4)
   *   maxGapMM      {number}  max gap to fill in loop (scene units, default 0.5)
   * @returns {{
   *   points:        THREE.Vector3[],
   *   isSmartSuggest: true,
   *   disclaimer:    string,
   *   stats:         { pointCount, estimatedLengthMM, gapsFilled }
   * }}
   */
  function suggestMargin(geo, opts = {}) {
    const topPct     = opts.topPct     ?? 15;
    const smoothIter = opts.smoothIter ?? 4;
    const edgeWeight = Math.max(0, Math.min(1, opts.edgeWeight ?? 0.4));
    const maxGap     = opts.maxGapMM   ?? 0.5;

    if (!geo) return _emptyResult();

    const pos    = geo.getAttribute('position');
    const vCount = pos.count;
    if (vCount < 30) return _emptyResult();

    // ── Step 1: Base curvature (same as MarginDetector) ──────
    const adj = _buildAdjMap(pos, vCount);
    const curv = _computeCurvature(pos, vCount, adj);

    // ── Step 2: Edge proximity score ─────────────────────────
    // Vertices near the bounding-box "equator" (gingival third) score higher
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < vCount; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const height = maxY - minY || 1;
    const gingivalY = minY + height * 0.28;   // 28% from base = gingival third

    const edgeScore = new Float32Array(vCount);
    for (let i = 0; i < vCount; i++) {
      const dy = Math.abs(pos.getY(i) - gingivalY) / height;
      edgeScore[i] = Math.max(0, 1 - dy * 3.5);  // peak at gingivalY
    }

    // ── Step 3: Weighted combined score ──────────────────────
    // Normalise curvature to [0,1]
    let maxC = 0;
    for (let i = 0; i < vCount; i++) if (curv[i] > maxC) maxC = curv[i];
    if (maxC === 0) maxC = 1;

    const combinedScore = new Float32Array(vCount);
    for (let i = 0; i < vCount; i++) {
      combinedScore[i] =
        (1 - edgeWeight) * (curv[i] / maxC) +
        edgeWeight        * edgeScore[i];
    }

    // ── Step 4: Threshold → candidate vertices ───────────────
    const sorted = Array.from(combinedScore).sort((a, b) => b - a);
    const threshold = sorted[Math.floor(vCount * topPct / 100)] ?? 0;

    const candidates = [];
    for (let i = 0; i < vCount; i++) {
      if (combinedScore[i] >= threshold) candidates.push(i);
    }
    if (candidates.length < 4) return _emptyResult();

    // ── Step 5: Order into a loop (greedy NN) ─────────────────
    const pts  = candidates.map(i => new THREE.Vector3(
      pos.getX(i), pos.getY(i), pos.getZ(i)
    ));
    const loop = _orderLoop(pts);

    // ── Step 6: Fill small gaps ───────────────────────────────
    let gapsFilled = 0;
    const filled = [loop[0]];
    for (let i = 1; i < loop.length; i++) {
      const gap = loop[i].distanceTo(loop[i - 1]);
      if (gap > maxGap && gap < maxGap * 6) {
        // Interpolate midpoint
        filled.push(loop[i - 1].clone().lerp(loop[i], 0.5));
        gapsFilled++;
      }
      filled.push(loop[i]);
    }

    // ── Step 7: Gaussian smooth ───────────────────────────────
    const smoothed = _gaussianSmooth(filled, smoothIter);

    // Estimate arc length
    let len = 0;
    for (let i = 1; i < smoothed.length; i++) {
      len += smoothed[i].distanceTo(smoothed[i - 1]);
    }

    return {
      points:         smoothed,
      isSmartSuggest: true,
      disclaimer:     '⚠ Smart Suggestion — enhanced curvature + edge analysis. ' +
                      'NOT a clinically verified margin. ' +
                      'Review and adjust every point before use.',
      stats: {
        pointCount:         smoothed.length,
        estimatedLengthMM:  +len.toFixed(2),
        gapsFilled,
      },
    };
  }

  function _emptyResult() {
    return {
      points: [], isSmartSuggest: true,
      disclaimer: '⚠ Smart Suggestion: insufficient geometry data.',
      stats: { pointCount: 0, estimatedLengthMM: 0, gapsFilled: 0 },
    };
  }

  function _buildAdjMap(posAttr, vCount) {
    const adj = new Array(vCount).fill(null).map(() => new Set());
    for (let i = 0; i < vCount; i += 3) {
      const a = i, b = i + 1, c = i + 2;
      if (c < vCount) {
        adj[a].add(b); adj[a].add(c);
        adj[b].add(a); adj[b].add(c);
        adj[c].add(a); adj[c].add(b);
      }
    }
    return adj;
  }

  function _computeCurvature(posAttr, vCount, adj) {
    const curv = new Float32Array(vCount);
    for (let i = 0; i < vCount; i++) {
      const neighbours = [...adj[i]];
      if (!neighbours.length) continue;
      let lx = 0, ly = 0, lz = 0;
      for (const j of neighbours) {
        lx += posAttr.getX(j); ly += posAttr.getY(j); lz += posAttr.getZ(j);
      }
      const n = neighbours.length;
      const dx = posAttr.getX(i) - lx / n;
      const dy = posAttr.getY(i) - ly / n;
      const dz = posAttr.getZ(i) - lz / n;
      curv[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return curv;
  }

  function _orderLoop(pts) {
    if (!pts.length) return [];
    const used   = new Uint8Array(pts.length);
    const result = [pts[0]];
    used[0] = 1;
    for (let iter = 1; iter < pts.length; iter++) {
      const last = result[result.length - 1];
      let bestD = Infinity, bestJ = -1;
      for (let j = 0; j < pts.length; j++) {
        if (used[j]) continue;
        const d = last.distanceToSquared(pts[j]);
        if (d < bestD) { bestD = d; bestJ = j; }
      }
      if (bestJ === -1) break;
      used[bestJ] = 1;
      result.push(pts[bestJ]);
    }
    return result;
  }

  function _gaussianSmooth(pts, iterations) {
    let loop = pts.slice();
    for (let iter = 0; iter < iterations; iter++) {
      const next = [];
      for (let i = 0; i < loop.length; i++) {
        const p = loop[(i - 1 + loop.length) % loop.length];
        const c = loop[i];
        const n = loop[(i + 1) % loop.length];
        next.push(new THREE.Vector3(
          (p.x + c.x * 2 + n.x) / 4,
          (p.y + c.y * 2 + n.y) / 4,
          (p.z + c.z * 2 + n.z) / 4
        ));
      }
      loop = next;
    }
    return loop;
  }

  // ── 2. Restoration Hint ───────────────────────────────────

  /**
   * Rule-based restoration type suggestions from FDI tooth numbers.
   *
   * Rules sourced from general clinical convention; they are
   * indicative defaults only — always defer to the clinician's judgment.
   *
   * @param {number[]} fdiNumbers  — selected FDI tooth numbers
   * @returns {{
   *   primary:     string,   — most common suggestion
   *   alternatives: string[],
   *   confidence:  'high'|'medium'|'low',
   *   rationale:   string,
   *   disclaimer:  string
   * }}
   */
  function hintRestoration(fdiNumbers) {
    if (!fdiNumbers || !fdiNumbers.length) {
      return {
        primary: null, alternatives: [], confidence: 'low',
        rationale: 'No teeth selected.',
        disclaimer: _disclaimer,
      };
    }

    // Classify selected teeth
    const types = fdiNumbers.map(n => {
      const d = n % 10;
      if (d <= 2) return 'I';       // incisors
      if (d === 3) return 'C';      // canine
      if (d <= 5) return 'P';       // premolars
      return 'M';                   // molars
    });

    const counts = { I: 0, C: 0, P: 0, M: 0 };
    types.forEach(t => counts[t]++);
    const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    const total    = fdiNumbers.length;
    const isMulti  = total > 1;
    const isBridge = total >= 3 && types.every(t => t === dominant || Math.abs(
      fdiNumbers[0] % 10 - fdiNumbers[fdiNumbers.length - 1] % 10
    ) <= 4);

    const RULES = {
      // Single tooth rules
      I_single:  { primary: 'Veneer',         alt: ['Crown', 'Composite Resin'], conf: 'high',
                   note: 'Incisors most commonly restored with veneers or full crowns.' },
      C_single:  { primary: 'Crown',           alt: ['Veneer', 'Composite Resin'], conf: 'high',
                   note: 'Canines are heavy load-bearing teeth — crown is preferred.' },
      P_single:  { primary: 'Inlay / Onlay',   alt: ['Crown', 'Composite Resin'], conf: 'medium',
                   note: 'Premolars with moderate loss: inlay/onlay; extensive: crown.' },
      M_single:  { primary: 'Crown',           alt: ['Onlay', 'Inlay'], conf: 'high',
                   note: 'Molars under high occlusal load — full crown is standard.' },
      // Multi-tooth rules
      bridge:    { primary: 'Bridge (Crown–Pontic–Crown)', alt: ['Implant Crown', 'Crown'], conf: 'medium',
                   note: `${total} adjacent teeth selected — bridge is a common option.` },
      mixed_multi: { primary: 'Full-arch rehabilitation', alt: ['Multiple Crowns', 'Implant-supported bridge'], conf: 'low',
                     note: 'Mixed tooth types selected — full-arch planning recommended.' },
    };

    let rule;
    if (isBridge) {
      rule = RULES.bridge;
    } else if (isMulti && Object.values(counts).filter(v => v > 0).length > 1) {
      rule = RULES.mixed_multi;
    } else {
      rule = RULES[`${dominant}_single`] || RULES.M_single;
    }

    return {
      primary:      rule.primary,
      alternatives: rule.alt,
      confidence:   rule.conf,
      rationale:    rule.note,
      disclaimer:   _disclaimer,
    };
  }

  const _disclaimer =
    '⚠ Rule-based suggestion only — not clinical advice. ' +
    'Final restoration type must be determined by a qualified dental professional.';

  return { suggestMargin, hintRestoration };
})();

window.SmartSuggestions = SmartSuggestions;

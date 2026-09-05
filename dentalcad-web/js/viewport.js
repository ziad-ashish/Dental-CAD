/**
 * viewport.js — Three.js 3D viewport
 *
 * New in this version:
 *  - loadGeometry(geo)  : replace placeholder with any parsed BufferGeometry
 *  - resetPlaceholder() : restore default tooth shape
 *  - exposes { scene, camera, renderer, mesh, canvas, render } to Tools
 *  - render() is public so tools can trigger a frame after mutations
 *  - setWireframe / setGridVisible / setMarginRing unchanged API
 *  - OrbitControls implemented inline (no external dep)
 *  - Pointer Events API (mouse + touch + pen, pinch-to-zoom)
 */

const Viewport = (() => {

  // ── Internal state ─────────────────────────────────────────
  let renderer, scene, camera;
  let toothGroup = null;
  let userMesh   = null;
  let gridGroup  = null;
  let canvas;

  // orbit state
  const orbit = {
    rotating: false, panning: false,
    lastX: 0, lastY: 0,
    rotX: 20, rotY: -30,
    panX: 0,  panY: 0,
    zoom: 6,
  };

  let meshMaterial = null;

  // ── Orbit helpers ──────────────────────────────────────────
  function _applyOrbit() {
    const rx = THREE.MathUtils.degToRad(orbit.rotX);
    const ry = THREE.MathUtils.degToRad(orbit.rotY);
    const r  = orbit.zoom;
    camera.position.set(
      r * Math.sin(ry) * Math.cos(rx) + orbit.panX,
      r * Math.sin(rx)               + orbit.panY,
      r * Math.cos(ry) * Math.cos(rx)
    );
    camera.lookAt(orbit.panX, orbit.panY, 0);
  }

  function _bindOrbit(el) {
    // ── Pointer Events API ─────────────────────────────────────
    // Handles mouse, touch, and digital pen uniformly.
    // Replaces separate mousedown/mousemove/mouseup + touch handlers.

    const pointers  = new Map();   // pointerId → {x, y}
    let _pinchDist0 = null;        // initial pinch distance
    let _pinchZoom0 = null;        // orbit.zoom at pinch start

    el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // Active tool consumes single-pointer events
      if (pointers.size === 1 && Tools.getActiveName()) return;

      if (pointers.size === 1) {
        orbit.lastX    = e.clientX;
        orbit.lastY    = e.clientY;
        // LMB or touch → rotate; RMB/MMB → pan
        orbit.rotating = (e.button === 0 || e.pointerType !== 'mouse');
        orbit.panning  = (e.button === 2 || e.button === 1);
      }

      // Two-pointer: start pinch-to-zoom, cancel orbit/pan
      if (pointers.size === 2) {
        orbit.rotating = false;
        orbit.panning  = false;
        const pts = [...pointers.values()];
        _pinchDist0 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        _pinchZoom0 = orbit.zoom;
      }

      e.preventDefault();
    }, { passive: false });

    el.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // ── Pinch zoom (two fingers) ─────────────────────────────
      if (pointers.size === 2 && _pinchDist0 !== null) {
        const pts  = [...pointers.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        orbit.zoom  = Math.max(1.2, Math.min(20, _pinchZoom0 * (_pinchDist0 / dist)));
        _applyOrbit();
        renderer.render(scene, camera);
        return;
      }

      // ── Single pointer orbit / pan ───────────────────────────
      if (pointers.size !== 1) return;
      if (Tools.getActiveName()) return;

      const dx = e.clientX - orbit.lastX;
      const dy = e.clientY - orbit.lastY;
      orbit.lastX = e.clientX;
      orbit.lastY = e.clientY;

      if (orbit.rotating) {
        orbit.rotY += dx * 0.4;
        orbit.rotX  = Math.max(-85, Math.min(85, orbit.rotX + dy * 0.4));
        _applyOrbit(); renderer.render(scene, camera);
      }
      if (orbit.panning) {
        orbit.panX -= dx * 0.007;
        orbit.panY += dy * 0.007;
        _applyOrbit(); renderer.render(scene, camera);
      }
    });

    const _onPointerEnd = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) { _pinchDist0 = null; _pinchZoom0 = null; }
      if (pointers.size === 0) { orbit.rotating = false; orbit.panning = false; }
    };
    el.addEventListener('pointerup',     _onPointerEnd);
    el.addEventListener('pointercancel', _onPointerEnd);

    // ── Mouse wheel / trackpad zoom ───────────────────────────
    el.addEventListener('wheel', e => {
      orbit.zoom = Math.max(1.2, Math.min(20, orbit.zoom + e.deltaY * 0.007));
      _applyOrbit(); renderer.render(scene, camera);
      e.preventDefault();
    }, { passive: false });

    el.addEventListener('contextmenu', e => e.preventDefault());

    // Prevent browser default pan/zoom on the canvas for touch devices
    el.style.touchAction = 'none';
  }

  // ── Default tooth placeholder — lower first molar ─────────
  /**
   * Anatomically-informed lower first molar (FDI #36) placeholder.
   *
   * CROWN
   *  - LatheGeometry profile: cervical constriction → equatorial bulge → occlusal
   *  - Scalloped CEJ via per-vertex sine-wave modulation (2 dips/cycle)
   *  - 5 Gaussian cusp bumps + central fossa + buccal groove on occlusal
   *  - Micro-noise (±0.025) breaks perfect rotational symmetry
   *  - Enamel: bright ivory, high shininess, warm specular
   *
   * CEJ BAND
   *  - Scalloped torus that visually separates crown from roots
   *  - Slightly lighter cementum colour
   *
   * ROOTS (lower molar = mesial + distal, 2 roots)
   *  - Cubic radius taper (stays wide near CEJ, narrows fast at apex)
   *  - S-curve deformation per root (buccal lean + apical hook)
   *  - Compression groove (mesial root)
   *  - Micro-noise on root surface
   *  - Darker cementum material, low shininess
   */
  function _buildPlaceholder() {
    const group = new THREE.Group();

    // ── Shared PRNG (reproducible micro-noise) ──────────────
    let _seed = 42;
    function _rand() {
      _seed = (_seed * 1664525 + 1013904223) & 0xFFFFFFFF;
      return (_seed >>> 0) / 0xFFFFFFFF - 0.5;   // -0.5 … +0.5
    }

    // ── Materials ───────────────────────────────────────────
    const enamelMat = new THREE.MeshPhongMaterial({
      color:     0xeee0c6,   // pale ivory — enamel
      specular:  0xd8c8a0,   // warm gloss
      shininess: 72,
      side:      THREE.DoubleSide,
    });
    meshMaterial = enamelMat;   // keep reference for loadGeometry()

    const cementumMat = new THREE.MeshPhongMaterial({
      color:     0xb89060,   // yellow-tan — cementum/dentin
      specular:  0x604828,
      shininess: 14,
      side:      THREE.DoubleSide,
    });

    const cejMat = new THREE.MeshPhongMaterial({
      color:     0xd4c090,
      specular:  0x888060,
      shininess: 30,
      side:      THREE.DoubleSide,
    });

    // ────────────────────────────────────────────────────────
    // CROWN  (LatheGeometry profile revolution)
    // ────────────────────────────────────────────────────────
    const SEGS = 36;
    const profile = [
      // [radius, y]     anatomical landmark
      [0.00,  1.00],    // occlusal centre
      [0.24,  0.98],    // central fossa rim
      [0.56,  0.88],    // inner occlusal table
      [0.72,  0.76],    // occlusal shoulder
      [0.84,  0.60],    // supra-equatorial taper
      [0.92,  0.40],    // equator (maximum convexity)
      [0.88,  0.20],    // sub-equatorial constriction
      [0.78,  0.08],    // cervical bulge
      [0.68,  0.00],    // CEJ (coordinate origin)
      [0.60, -0.08],    // sub-CEJ transition to root trunk
    ].map(([r, y]) => new THREE.Vector2(r, y));

    const crownGeo = new THREE.LatheGeometry(profile, SEGS);
    const cPos     = crownGeo.attributes.position;

    // 5 cusp centres (MB, DB, ML, DL + distal minor)
    const cusps = [
      { ax:  0.50, az:  0.52, h: 0.16, r: 0.28 },
      { ax: -0.50, az:  0.52, h: 0.15, r: 0.28 },
      { ax:  0.48, az: -0.50, h: 0.15, r: 0.28 },
      { ax: -0.48, az: -0.50, h: 0.14, r: 0.28 },
      { ax: -0.10, az:  0.70, h: 0.08, r: 0.18 },   // distal minor cusp
    ];

    // Buccal groove (depression on buccal face)
    const bGroove = { ax: 0.0, az: 0.62, depth: -0.04, r: 0.15 };

    for (let i = 0; i < cPos.count; i++) {
      let vx = cPos.getX(i);
      let vy = cPos.getY(i);
      let vz = cPos.getZ(i);

      // ── 1. Scalloped CEJ ────────────────────────────────────
      if (Math.abs(vy) < 0.16) {
        const angle   = Math.atan2(vz, vx);
        const scallop = 0.045 * Math.sin(angle * 2 + 0.4);
        vy += scallop * (1 - Math.abs(vy) / 0.16);
      }

      // ── 2. Occlusal surface (cusps + fossa + groove) ────────
      if (vy > 0.60) {
        let bumpY = 0;
        for (const { ax, az, h, r } of cusps) {
          const dx = vx - ax, dz = vz - az;
          bumpY += h * Math.exp(-(dx*dx + dz*dz) / (r * r));
        }
        // Central fossa depression
        const cfDist = Math.sqrt(vx*vx + vz*vz);
        bumpY -= 0.08 * Math.exp(-(cfDist * cfDist) / 0.06);
        // Buccal groove
        const bgDx = vx - bGroove.ax, bgDz = vz - bGroove.az;
        bumpY += bGroove.depth * Math.exp(-(bgDx*bgDx + bgDz*bgDz) / (bGroove.r * bGroove.r));
        vy += bumpY;
      }

      // ── 3. Micro-noise ───────────────────────────────────────
      const noise = 0.025 * _rand();
      const rDist = Math.sqrt(vx*vx + vz*vz);
      vx += noise * rDist * 0.6;
      vz += noise * rDist * 0.6;
      vy += noise * 0.5;

      cPos.setXYZ(i, vx, vy, vz);
    }

    crownGeo.computeVertexNormals();
    const crown = new THREE.Mesh(crownGeo, enamelMat);
    crown.scale.set(1.08, 0.88, 1.00);
    group.add(crown);

    // ────────────────────────────────────────────────────────
    // CEJ BAND (scalloped torus at cervical line)
    // ────────────────────────────────────────────────────────
    const cejGeo = new THREE.TorusGeometry(0.68, 0.028, 10, SEGS);
    const cejPos = cejGeo.attributes.position;
    for (let i = 0; i < cejPos.count; i++) {
      const ang     = Math.atan2(cejPos.getZ(i), cejPos.getX(i));
      const scallop = 0.04 * Math.sin(ang * 2 + 0.4);
      cejPos.setY(i, cejPos.getY(i) + scallop);
    }
    cejGeo.computeVertexNormals();
    const cejRing = new THREE.Mesh(cejGeo, cejMat);
    cejRing.scale.set(1.08, 1.0, 1.00);
    cejRing.position.y = 0.01;
    cejRing.rotation.x = Math.PI / 2;
    group.add(cejRing);

    // ────────────────────────────────────────────────────────
    // ROOTS  (2: mesial + distal)
    // ────────────────────────────────────────────────────────
    function _makeRoot(params) {
      const { rCEJ, rApex, length, radialSegs, heightSegs,
              offX, offZ, curveX, curveZ, apexX, apexZ } = params;

      const geo = new THREE.CylinderGeometry(rCEJ, rApex, length, radialSegs, heightSegs, false);
      const rp  = geo.attributes.position;

      for (let i = 0; i < rp.count; i++) {
        let vx = rp.getX(i);
        let vy = rp.getY(i);
        let vz = rp.getZ(i);

        // t = 0 at CEJ (top), t = 1 at apex (bottom)
        const t = (vy / (-length) + 0.5);

        // ── Cubic radius taper ───────────────────────────────
        const rLinear = rCEJ + (rApex - rCEJ) * t;
        const rCubic  = rCEJ + (rApex - rCEJ) * (t * t * (3 - 2 * t));
        const sc      = rLinear > 0.001 ? (rCubic / rLinear) : 1;
        vx *= sc;
        vz *= sc;

        // ── S-curve (lean + apical hook) ─────────────────────
        const curveT = Math.sin(t * Math.PI * 0.85);
        vx += curveX * curveT + apexX * t * t;
        vz += curveZ * curveT + apexZ * t * t;

        // ── Compression groove (mesial face) ─────────────────
        const angle  = Math.atan2(vz, vx);
        const groove = 0.022 * Math.exp(-Math.pow(angle - Math.PI * 0.5, 2) / 0.3);
        const r      = Math.sqrt(vx*vx + vz*vz);
        if (r > 0.01) { vx *= (1 - groove / r); vz *= (1 - groove / r); }

        // ── Micro-noise ──────────────────────────────────────
        _seed = (i * 7 + 99) | 0;
        vx += 0.012 * _rand() * (1 - t);
        vz += 0.012 * _rand() * (1 - t);

        rp.setXYZ(i, vx, vy, vz);
      }
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, cementumMat);
      mesh.position.set(offX, -(length * 0.5 + 0.02), offZ);
      return mesh;
    }

    // Mesial root — longer, more curved, mesial lean
    group.add(_makeRoot({
      rCEJ: 0.26, rApex: 0.055, length: 1.75,
      radialSegs: 16, heightSegs: 8,
      offX:  0.24, offZ:  0.10,
      curveX: -0.12, curveZ:  0.06,
      apexX: -0.06,  apexZ:  0.02,
    }));

    // Distal root — shorter, more upright
    group.add(_makeRoot({
      rCEJ: 0.24, rApex: 0.048, length: 1.52,
      radialSegs: 16, heightSegs: 8,
      offX: -0.24, offZ:  0.10,
      curveX:  0.08, curveZ:  0.04,
      apexX:  0.04,  apexZ:  0.02,
    }));

    // ── Margin ring (cyan) — hidden by default ───────────────
    const marginRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.72, 0.022, 8, SEGS),
      new THREE.MeshBasicMaterial({ color: 0x00aaff })
    );
    marginRing.name = 'marginRing';
    marginRing.scale.set(1.08, 1.0, 1.00);
    marginRing.position.y = 0.03;
    marginRing.rotation.x = Math.PI / 2;
    marginRing.visible = false;
    group.add(marginRing);

    group.position.y = 0.55;
    return group;
  }

  function _makeMaterial() {
    return new THREE.MeshPhongMaterial({
      color:     0xeee0c6,
      specular:  0xd8c8a0,
      shininess: 72,
      side:      THREE.DoubleSide,
    });
  }

  // ── Grid ───────────────────────────────────────────────────
  function _buildGrid() {
    const g    = new THREE.Group();
    const mat  = new THREE.LineBasicMaterial({ color: 0x383840, transparent: true, opacity: 0.7 });
    const size = 6, step = 0.5;
    for (let x = -size; x <= size; x += step) {
      g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x,-2.6,-size),new THREE.Vector3(x,-2.6,size)]),
        mat
      ));
    }
    for (let z = -size; z <= size; z += step) {
      g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-size,-2.6,z),new THREE.Vector3(size,-2.6,z)]),
        mat
      ));
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-size,-2.6,0),new THREE.Vector3(size,-2.6,0)]),
      new THREE.LineBasicMaterial({ color: 0xcc3333 })));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,-2.6,-size),new THREE.Vector3(0,-2.6,size)]),
      new THREE.LineBasicMaterial({ color: 0x33cc33 })));
    return g;
  }


  // ── 2-D fallback ───────────────────────────────────────────
  function _drawFallback(el, msg) {
    const ctx2 = el.getContext('2d');
    if (!ctx2) return;
    const message = msg || '3D Viewport — loading Three.js…';
    const draw = () => {
      const w = el.width  || el.parentElement?.offsetWidth  || 400;
      const h = el.height || el.parentElement?.offsetHeight || 300;
      if (el.width  !== w) el.width  = w;
      if (el.height !== h) el.height = h;
      const g = ctx2.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#1c1c1e'); g.addColorStop(1, '#111113');
      ctx2.fillStyle = g; ctx2.fillRect(0, 0, w, h);
      ctx2.save();
      ctx2.translate(w / 2, h / 2 - 40);
      ctx2.strokeStyle = 'rgba(59,130,246,0.4)';
      ctx2.lineWidth   = 2;
      ctx2.beginPath();
      ctx2.arc(0, 0, 28, 0, Math.PI * 2);
      ctx2.stroke();
      ctx2.fillStyle = 'rgba(59,130,246,0.15)';
      ctx2.fill();
      ctx2.fillStyle = 'rgba(96,165,250,0.7)';
      ctx2.font = '26px serif';
      ctx2.textAlign = 'center';
      ctx2.textBaseline = 'middle';
      ctx2.fillText('🦷', 0, 1);
      ctx2.restore();
      ctx2.fillStyle = '#9ca3af';
      ctx2.font = '13px "Inter", system-ui, sans-serif';
      ctx2.textAlign = 'center';
      ctx2.textBaseline = 'alphabetic';
      ctx2.fillText(message, w / 2, h / 2 + 10);
      ctx2.fillStyle = '#4b5563';
      ctx2.font = '11px "Inter", system-ui, sans-serif';
      ctx2.fillText('LMB: Rotate  ·  RMB: Pan  ·  Scroll: Zoom', w / 2, h / 2 + 30);
    };
    draw();
    window.addEventListener('resize', draw);
  }

  // ── Init ───────────────────────────────────────────────────
  function init(canvasEl) {
    canvas = canvasEl;

    if (typeof THREE === 'undefined') {
      console.error('DentalCAD: THREE.js not loaded — check CDN or network.');
      _drawFallback(canvasEl, 'Three.js failed to load. Check your internet connection and reload.');
      return;
    }

    // Guard: if canvas is still 0×0 (parent not painted yet), resize from parent
    const w0 = canvasEl.offsetWidth  || canvasEl.width;
    const h0 = canvasEl.offsetHeight || canvasEl.height;
    if (w0 === 0 || h0 === 0) {
      console.warn('Viewport.init: canvas is 0×0, retrying after next frame…');
      const parent = canvasEl.parentElement;
      if (parent) {
        canvasEl.width  = parent.offsetWidth  || 400;
        canvasEl.height = parent.offsetHeight || 300;
      }
    }

    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x111113, 1);
      renderer.localClippingEnabled = true;

      scene  = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x111113, 0.035);

      camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);

      // Lighting
      scene.add(new THREE.AmbientLight(0x404050, 0.9));
      const dir = new THREE.DirectionalLight(0xd0d8ff, 1.2);
      dir.position.set(3, 6, 4);
      scene.add(dir);
      const fill = new THREE.DirectionalLight(0x8090a0, 0.4);
      fill.position.set(-4, -2, -3);
      scene.add(fill);

      // Grid
      gridGroup = _buildGrid();
      scene.add(gridGroup);

      // Placeholder tooth
      toothGroup = _buildPlaceholder();
      scene.add(toothGroup);

      // Orbit controls
      _bindOrbit(canvasEl);
      _applyOrbit();

      // Expose context to tools
      _exposeToTools();

      resize();
      window.addEventListener('resize', resize);
      renderer.render(scene, camera);

    } catch (e) {
      console.error('Viewport.init failed:', e);
      _drawFallback(canvasEl, `3D init failed: ${e.message || e}`);
    }
  }

  function _exposeToTools() {
    Tools.setContext({
      get scene()    { return scene; },
      get camera()   { return camera; },
      get renderer() { return renderer; },
      get mesh()     { return _getActiveMesh(); },
      get canvas()   { return canvas; },
      render,
    });
  }

  // ── Load parsed geometry ───────────────────────────────────
  function loadGeometry(geo, stats) {
    if (userMesh) { scene.remove(userMesh); userMesh = null; }
    if (toothGroup) toothGroup.visible = false;

    const mat = _makeMaterial();
    userMesh  = new THREE.Mesh(geo, mat);
    userMesh.geometry.userData.stats = stats || {};
    meshMaterial = mat;
    scene.add(userMesh);

    _exposeToTools();

    orbit.rotX = 20; orbit.rotY = -30;
    orbit.panX = 0;  orbit.panY = 0;
    orbit.zoom = 5;
    _applyOrbit();
    renderer.render(scene, camera);
  }

  // ── Restore placeholder ────────────────────────────────────
  function resetPlaceholder() {
    if (userMesh) { scene.remove(userMesh); userMesh = null; }
    if (toothGroup) toothGroup.visible = true;
    _exposeToTools();
    renderer.render(scene, camera);
  }

  // ── Resize ─────────────────────────────────────────────────
  function resize() {
    if (!renderer || !canvas) return;
    const c = canvas.parentElement;
    const w = c.clientWidth, h = c.clientHeight || 300;
    canvas.width  = w;
    canvas.height = h;
    renderer.setSize(w, h, false);
    if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
    renderer.render(scene, camera);
  }

  // ── Render (public) ────────────────────────────────────────
  function render() {
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  // ── Viewport controls ──────────────────────────────────────
  function setGridVisible(v) {
    if (gridGroup) { gridGroup.visible = v; render(); }
  }

  function setWireframe(v) {
    [userMesh, toothGroup && toothGroup.children[0]].forEach(m => {
      if (m && m.material) { m.material.wireframe = v; m.material.needsUpdate = true; }
    });
    render();
  }

  function setMarginRing(v) {
    if (!toothGroup) return;
    const r = toothGroup.getObjectByName('marginRing');
    if (r) { r.visible = v; render(); }
  }

  function setView(preset) {
    const presets = {
      front: { rotX: 0,  rotY: 0,   zoom: 5, panX: 0, panY: 0 },
      top:   { rotX: 88, rotY: 0,   zoom: 5, panX: 0, panY: 0 },
      side:  { rotX: 0,  rotY: 90,  zoom: 5, panX: 0, panY: 0 },
      free:  { rotX: 20, rotY: -30, zoom: 5, panX: 0, panY: 0 },
    };
    Object.assign(orbit, presets[preset] || presets.free);
    _applyOrbit(); render();
  }

  function setColor(hex) {
    if (meshMaterial) {
      meshMaterial.color.set(hex);
      meshMaterial.needsUpdate = true;
      render();
    }
  }

  // ── Current geometry accessor ──────────────────────────────
  function getCurrentGeometry() {
    const m = _getActiveMesh();
    return m ? m.geometry : null;
  }

  function _getActiveMesh() {
    if (userMesh) return userMesh;
    if (toothGroup && toothGroup.visible) {
      // Return the crown mesh (first LatheGeometry child)
      for (const child of toothGroup.children) {
        if (child.isMesh) return child;
      }
    }
    return null;
  }

  return {
    init, resize, render,
    loadGeometry, resetPlaceholder, getCurrentGeometry,
    setGridVisible, setWireframe, setMarginRing, setView, setColor,
    getMeshMaterial: () => meshMaterial,
    getScene:        () => scene,
    getCamera:       () => camera,
    getRenderer:     () => renderer,
    getCurrentMesh:  () => (userMesh || (toothGroup && toothGroup.children[0]) || null),
  };
})();
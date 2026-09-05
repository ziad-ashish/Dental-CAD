// ═══════════════════════════════════════════════════════════
// stl-parser.js
// ═══════════════════════════════════════════════════════════
/**
 * stl-parser.js  —  v2
 *
 * Parses:  Binary STL, ASCII STL, OBJ
 * Exports: Binary STL (fast, typed-array), ASCII STL, OBJ+normals,
 *          PLY binary, PLY ASCII, 3MF XML
 *
 * Important: geometry stored in viewport is centre-normalised to ~3.5 units.
 * All export functions accept an optional `outputScale` multiplier so the
 * file lands in the correct physical unit (mm, inches, …).
 *
 * parseFile(file)
 *   → { geometry: THREE.BufferGeometry, stats, _importScale, _importOffset }
 *
 * exportBinarySTL(geometry, outputScale?)  → ArrayBuffer
 * exportASCIISTL (geometry, outputScale?)  → string
 * exportOBJ      (geometry, outputScale?)  → string
 * exportBinaryPLY(geometry, outputScale?)  → ArrayBuffer
 * exportASCIIPLY (geometry, outputScale?)  → string
 * export3MF      (geometry, outputScale?)  → string (XML)
 *
 * estimateExportSize(geometry, format)     → number (bytes, approximate)
 */

const STLParser = (() => {
  const MAX_SCAN_BYTES = 512 * 1024 * 1024;
  const MAX_TRIANGLES = 10_000_000;

  // ═══════════════════════════════════════════════════════════
  // PARSE — Binary STL
  // ═══════════════════════════════════════════════════════════
  function _parseBinarySTL(buffer) {
    const view     = new DataView(buffer);
    const triCount = view.getUint32(80, true);

    const positions = new Float32Array(triCount * 9);
    const normals   = new Float32Array(triCount * 9);

    let offset = 84;
    for (let i = 0; i < triCount; i++) {
      const nx = view.getFloat32(offset,      true);
      const ny = view.getFloat32(offset +  4, true);
      const nz = view.getFloat32(offset +  8, true);
      offset += 12;

      for (let v = 0; v < 3; v++) {
        const base = i * 9 + v * 3;
        positions[base]     = view.getFloat32(offset,     true);
        positions[base + 1] = view.getFloat32(offset + 4, true);
        positions[base + 2] = view.getFloat32(offset + 8, true);
        normals[base]       = nx;
        normals[base + 1]   = ny;
        normals[base + 2]   = nz;
        offset += 12;
      }
      offset += 2; // attribute byte count
    }
    return { positions, normals, triCount };
  }

  // ═══════════════════════════════════════════════════════════
  // PARSE — ASCII STL
  // ═══════════════════════════════════════════════════════════
  function _parseASCIISTL(text) {
    const positions = [];
    const normals   = [];
    let triCount    = 0;

    // Match every facet block
    const facetRe  = /facet\s+normal\s+([\S]+)\s+([\S]+)\s+([\S]+)[\s\S]*?outer\s+loop([\s\S]*?)endloop/g;
    const vertexRe = /vertex\s+([\S]+)\s+([\S]+)\s+([\S]+)/g;

    let fm;
    while ((fm = facetRe.exec(text)) !== null) {
      const nx = parseFloat(fm[1]);
      const ny = parseFloat(fm[2]);
      const nz = parseFloat(fm[3]);
      const loopBlock = fm[4];

      vertexRe.lastIndex = 0;
      let vCount = 0;
      let vm;
      while ((vm = vertexRe.exec(loopBlock)) !== null && vCount < 3) {
        positions.push(parseFloat(vm[1]), parseFloat(vm[2]), parseFloat(vm[3]));
        normals.push(nx, ny, nz);
        vCount++;
      }
      if (vCount === 3) triCount++;
      else {
        positions.splice(Math.max(0, positions.length - vCount * 3), vCount * 3);
        normals.splice(Math.max(0, normals.length - vCount * 3), vCount * 3);
      }
    }
    return {
      positions: new Float32Array(positions),
      normals:   new Float32Array(normals),
      triCount,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // PARSE — OBJ
  // ═══════════════════════════════════════════════════════════
  function _parseOBJ(text) {
    const rawVerts  = [];   // [[x,y,z],...]
    const rawNormals= [];   // [[nx,ny,nz],...]
    const positions = [];
    const normals   = [];
    let triCount    = 0;

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('v ')) {
        const p = line.split(/\s+/);
        const v = [parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])];
        if (v.length !== 3 || !v.every(Number.isFinite)) throw new Error('Invalid OBJ vertex');
        rawVerts.push(v);
      } else if (line.startsWith('vn ')) {
        const p = line.split(/\s+/);
        const n = [parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])];
        if (n.length !== 3 || !n.every(Number.isFinite)) throw new Error('Invalid OBJ normal');
        rawNormals.push(n);
      } else if (line.startsWith('f ')) {
        const parts = line.split(/\s+/).slice(1);
        if (parts.length < 3) throw new Error('Invalid OBJ face');
        // Fan-triangulate polygons (>3 verts)
        for (let i = 1; i < parts.length - 1; i++) {
          for (const token of [parts[0], parts[i], parts[i + 1]]) {
            const idx = token.split('/');
            const rawVi = parseInt(idx[0], 10);
            const vi = rawVi < 0 ? rawVerts.length + rawVi : rawVi - 1;
            if (!Number.isInteger(rawVi) || !rawVerts[vi]) throw new Error('OBJ face references missing vertex');
            const rawVni = idx[2] ? parseInt(idx[2], 10) : 0;
            const vni = rawVni < 0 ? rawNormals.length + rawVni : rawVni - 1;
            if (idx[2] && (!Number.isInteger(rawVni) || !rawNormals[vni])) throw new Error('OBJ face references missing normal');
            const v   = rawVerts[vi];
            positions.push(v[0], v[1], v[2]);
            const n = vni >= 0 ? rawNormals[vni] : null;
            normals.push(n ? n[0] : 0, n ? n[1] : 1, n ? n[2] : 0);
          }
          triCount++;
        }
      }
    }
    return {
      positions: new Float32Array(positions),
      normals:   new Float32Array(normals),
      triCount,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // PARSE — ASCII PLY (vertices + polygon faces)
  // ═══════════════════════════════════════════════════════════
  function _parseASCIIPLY(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    if (lines[0].trim().toLowerCase() !== 'ply') throw new Error('Invalid PLY header');
    let headerEnd = -1, vertexCount = 0, faceCount = 0, element = '';
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts[0] === 'element') {
        element = parts[1];
        if (element === 'vertex') vertexCount = parseInt(parts[2], 10) || 0;
        if (element === 'face') faceCount = parseInt(parts[2], 10) || 0;
      }
      if (parts[0] === 'end_header') { headerEnd = i; break; }
    }
    if (headerEnd < 0 || !vertexCount) throw new Error('Invalid PLY header or vertex count');
    const verts = [];
    for (let i = 0; i < vertexCount; i++) {
      const p = lines[headerEnd + 1 + i].trim().split(/\s+/).map(Number);
      if (p.length < 3 || !p.slice(0, 3).every(Number.isFinite)) throw new Error('Invalid PLY vertex');
      verts.push([p[0], p[1], p[2]]);
    }
    const positions = [], normals = [];
    for (let i = 0; i < faceCount; i++) {
      const parts = lines[headerEnd + 1 + vertexCount + i].trim().split(/\s+/).map(Number);
      const n = parts[0];
      if (!Number.isInteger(n) || n < 3 || parts.length < n + 1) continue;
      const ids = parts.slice(1, n + 1);
      for (let j = 1; j < ids.length - 1; j++) {
        for (const id of [ids[0], ids[j], ids[j + 1]]) {
          const v = verts[id];
          if (!v) throw new Error('PLY face references missing vertex');
          positions.push(v[0], v[1], v[2]);
          normals.push(0, 1, 0);
        }
      }
    }
    return { positions: new Float32Array(positions), normals: new Float32Array(normals), triCount: positions.length / 9 };
  }

  // ═══════════════════════════════════════════════════════════
  // PARSE — binary PLY (little/big endian, scalar vertex props)
  // ═══════════════════════════════════════════════════════════
  function _parseBinaryPLY(buffer) {
    const bytes = new Uint8Array(buffer);
    const marker = new TextEncoder().encode('end_header');
    let markerAt = -1;
    for (let i = 0; i <= bytes.length - marker.length; i++) {
      let match = true;
      for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) { match = false; break; }
      if (match) { markerAt = i; break; }
    }
    if (markerAt < 0) throw new Error('Invalid binary PLY header');
    let dataStart = markerAt + marker.length;
    while (dataStart < bytes.length && (bytes[dataStart] === 10 || bytes[dataStart] === 13 || bytes[dataStart] === 32 || bytes[dataStart] === 9)) dataStart++;
    const header = new TextDecoder().decode(bytes.slice(0, markerAt)).replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
    if (header[0]?.toLowerCase() !== 'ply') throw new Error('Invalid PLY header');
    const format = header.find(line => line.startsWith('format '));
    const little = format?.includes('binary_little_endian');
    const big = format?.includes('binary_big_endian');
    if (!little && !big) throw new Error('Unsupported binary PLY format');
    const sizes = { char:1, int8:1, uchar:1, uint8:1, short:2, int16:2, ushort:2, uint16:2, int:4, int32:4, uint:4, uint32:4, float:4, float32:4, double:8, float64:8 };
    const readValue = (view, offset, type) => {
      const t = type.toLowerCase(), le = little;
      if (!(t in sizes)) throw new Error(`Unsupported PLY property type: ${type}`);
      if (t === 'char' || t === 'int8') return view.getInt8(offset);
      if (t === 'uchar' || t === 'uint8') return view.getUint8(offset);
      if (t === 'short' || t === 'int16') return view.getInt16(offset, le);
      if (t === 'ushort' || t === 'uint16') return view.getUint16(offset, le);
      if (t === 'int' || t === 'int32') return view.getInt32(offset, le);
      if (t === 'uint' || t === 'uint32') return view.getUint32(offset, le);
      if (t === 'float' || t === 'float32') return view.getFloat32(offset, le);
      return view.getFloat64(offset, le);
    };
    const elements = [];
    let current = null;
    for (const line of header.slice(1)) {
      const p = line.split(/\s+/);
      if (p[0] === 'element') { current = { name: p[1], count: Number(p[2]), props: [] }; if (!Number.isInteger(current.count) || current.count < 0) throw new Error('Invalid PLY element count'); elements.push(current); }
      else if (p[0] === 'property' && current) {
        if (p[1] === 'list') current.props.push({ list: true, countType: p[2], itemType: p[3], name: p[4] });
        else current.props.push({ list: false, type: p[1], name: p[2] });
      }
    }
    const vertexEl = elements.find(e => e.name === 'vertex'), faceEl = elements.find(e => e.name === 'face');
    if (!vertexEl || !vertexEl.count || !faceEl) throw new Error('Binary PLY requires vertex and face elements');
    const view = new DataView(buffer), positions = [], normals = [], verts = [], vertexStride = vertexEl.props.reduce((n, p) => n + (p.list ? 0 : sizes[p.type.toLowerCase()] || 0), 0);
    if (!vertexStride) throw new Error('Invalid binary PLY vertex properties');
    let off = dataStart;
    for (let i = 0; i < vertexEl.count; i++) {
      const v = {}; for (const p of vertexEl.props) { if (p.list) throw new Error('List vertex properties are unsupported'); if (off + sizes[p.type.toLowerCase()] > buffer.byteLength) throw new Error('Truncated binary PLY vertex data'); v[p.name] = readValue(view, off, p.type); off += sizes[p.type.toLowerCase()]; }
      if (![v.x, v.y, v.z].every(Number.isFinite)) throw new Error('Invalid binary PLY vertex');
      verts.push(v);
    }
    const faceProp = faceEl.props.find(p => p.list);
    if (!faceProp) throw new Error('Binary PLY face list is missing');
    for (let i = 0; i < faceEl.count; i++) {
      let ids = null;
      for (const p of faceEl.props) {
        if (p.list) {
          if (off + sizes[p.countType.toLowerCase()] > buffer.byteLength) throw new Error('Truncated binary PLY face data');
          const n = readValue(view, off, p.countType); off += sizes[p.countType.toLowerCase()];
          if (!Number.isInteger(n) || n < 0) throw new Error('Invalid binary PLY face list');
          const values = [];
          for (let j = 0; j < n; j++) { if (off + sizes[p.itemType.toLowerCase()] > buffer.byteLength) throw new Error('Truncated binary PLY face data'); const value = readValue(view, off, p.itemType); off += sizes[p.itemType.toLowerCase()]; values.push(value); }
          if (p === faceProp) ids = values;
        } else {
          if (!(p.type.toLowerCase() in sizes) || off + sizes[p.type.toLowerCase()] > buffer.byteLength) throw new Error('Truncated binary PLY face data');
          off += sizes[p.type.toLowerCase()];
        }
      }
      if (!ids || ids.length < 3) throw new Error('Invalid binary PLY face');
      for (const id of ids) if (!Number.isInteger(id) || !verts[id]) throw new Error('PLY face references missing vertex');
      for (let j = 1; j < ids.length - 1; j++) for (const id of [ids[0], ids[j], ids[j + 1]]) { const v = verts[id]; positions.push(v.x, v.y, v.z); normals.push(v.nx ?? 0, v.ny ?? 0, v.nz ?? 0); }
    }
    return { positions: new Float32Array(positions), normals: new Float32Array(normals), triCount: positions.length / 9 };
  }

  // ═══════════════════════════════════════════════════════════
  // DETECT binary vs ASCII STL
  // ═══════════════════════════════════════════════════════════
  function _isBinarySTL(buffer) {
    if (buffer.byteLength < 84) return false;
    const view     = new DataView(buffer);
    const triCount = view.getUint32(80, true);
    // Allow ±4 bytes tolerance for files with trailing data
    return Math.abs(buffer.byteLength - (84 + triCount * 50)) <= 4;
  }

  // ═══════════════════════════════════════════════════════════
  // BUILD GEOMETRY — normalise to viewport units, store inverse transform
  // ═══════════════════════════════════════════════════════════
  function _buildGeometry(parsed, fileSize = 0) {
    const { positions, normals, triCount } = parsed;
    const vCount = positions.length / 3;

    // Bounding box in original units
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i+1], z = positions[i+2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;

    const maxDim    = Math.max(dx, dy, dz) || 1;
    const viewScale = 3.5 / maxDim;   // viewport normalisation scale

    // Centre & scale for Three.js viewport
    const finalPos = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      finalPos[i]   = (positions[i]   - cx) * viewScale;
      finalPos[i+1] = (positions[i+1] - cy) * viewScale;
      finalPos[i+2] = (positions[i+2] - cz) * viewScale;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(finalPos, 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(
      normals.length === positions.length ? normals.slice() : new Float32Array(positions.length),
      3
    ));

    const hasNormals = normals.some(v => v !== 0);
    if (!hasNormals) geo.computeVertexNormals();

    // Store the transform so exporters can reverse it
    geo.userData.importOffset    = { x: cx, y: cy, z: cz };  // original centroid
    geo.userData.importViewScale = viewScale;                  // viewport → original units

    const stats = {
      vertices:   vCount,
      triangles:  triCount,
      dimensions: { x: dx.toFixed(2), y: dy.toFixed(2), z: dz.toFixed(2) },
      rawSize:    fileSize,
    };
    geo.userData.stats = stats;

    return { geometry: geo, stats };
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC — parseFile
  // ═══════════════════════════════════════════════════════════
  async function parseFile(file) {
    return new Promise((resolve, reject) => {
      const declaredSize = Number(file?.size);
      if (Number.isFinite(declaredSize) && declaredSize > MAX_SCAN_BYTES) {
        reject(new Error(`Scan file exceeds the ${MAX_SCAN_BYTES / (1024 * 1024)} MB safety limit`));
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const buffer = e.target.result;
          const name   = (file.name || '').toLowerCase();
          let parsed;

          if (name.endsWith('.obj')) {
            parsed = _parseOBJ(new TextDecoder().decode(buffer));
          } else if (name.endsWith('.ply')) {
            const header = new TextDecoder().decode(buffer.slice(0, Math.min(buffer.byteLength, 4096))).toLowerCase();
            parsed = header.includes('format binary_little_endian') || header.includes('format binary_big_endian') ? _parseBinaryPLY(buffer) : _parseASCIIPLY(new TextDecoder().decode(buffer));
          } else if (name.endsWith('.stl') && _isBinarySTL(buffer)) {
            parsed = _parseBinarySTL(buffer);
          } else if (name.endsWith('.stl')) {
            // ASCII STL (also catches binary files that start with "solid")
            parsed = _parseASCIISTL(new TextDecoder().decode(buffer));
          } else {
            reject(new Error('Unsupported scan format. Use STL, OBJ, or PLY.'));
            return;
          }

          if (!parsed.triCount || !parsed.positions.length) {
            reject(new Error('Mesh contains no triangles'));
            return;
          }
          if (parsed.triCount > MAX_TRIANGLES) {
            reject(new Error(`Mesh exceeds the ${MAX_TRIANGLES.toLocaleString()} triangle safety limit`));
            return;
          }
          const result = _buildGeometry(parsed, file.size);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }

  // ═══════════════════════════════════════════════════════════
  // EXPORT HELPERS
  // ═══════════════════════════════════════════════════════════

  /**
   * Build a Float32Array of [x,y,z, x,y,z, …] positions
   * in output units (mm by default) by reversing the viewport normalisation.
   *
   * @param {THREE.BufferGeometry} geo
   * @param {number} outputScale  1.0 = millimetres (default)
   *                              25.4 = inches (mm → in)
   * @returns {{ pos: Float32Array, nor: Float32Array, triCount: number }}
   */
  function _getExportBuffers(geo, outputScale = 1.0) {
    if (!geo?.getAttribute) throw new Error('A mesh geometry is required for export');
    if (!Number.isFinite(outputScale) || outputScale <= 0) throw new Error('Export scale must be positive');
    const posAttr  = geo.getAttribute('position');
    const indexAttr = geo.getIndex?.() || null;
    if (!posAttr?.count || (indexAttr ? indexAttr.count % 3 !== 0 : posAttr.count % 3 !== 0)) throw new Error('Mesh must contain complete triangles for export');
    for (let i = 0; i < posAttr.array.length; i++) if (!Number.isFinite(posAttr.array[i])) throw new Error('Mesh contains non-finite coordinates');
    const normAttr = geo.getAttribute('normal');
    const vCount   = indexAttr ? indexAttr.count : posAttr.count;
    const triCount = Math.floor(vCount / 3);

    // Reverse the viewport normalisation
    const viewScale = geo.userData.importViewScale || 1;
    const off       = geo.userData.importOffset || { x: 0, y: 0, z: 0 };
    // viewport_coord = (original - offset) * viewScale
    // original       = viewport_coord / viewScale + offset
    // output         = original * outputScale  (if outputScale = 1, stays in mm)
    const invScale  = outputScale / viewScale;

    const pos = new Float32Array(vCount * 3);
    const nor = new Float32Array(vCount * 3);

    for (let i = 0; i < vCount; i++) {
      const sourceIndex = indexAttr ? indexAttr.getX(i) : i;
      if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= posAttr.count) throw new Error('Mesh index references missing vertex');
      pos[i*3]   = posAttr.getX(sourceIndex) * invScale + off.x * outputScale;
      pos[i*3+1] = posAttr.getY(sourceIndex) * invScale + off.y * outputScale;
      pos[i*3+2] = posAttr.getZ(sourceIndex) * invScale + off.z * outputScale;

      if (normAttr) {
        nor[i*3]   = normAttr.getX(sourceIndex);
        nor[i*3+1] = normAttr.getY(sourceIndex);
        nor[i*3+2] = normAttr.getZ(sourceIndex);
      }
    }

    // If normals were all zero, compute face normals inline
    const hasNor = nor.some(v => v !== 0);
    if (!hasNor) {
      for (let i = 0; i < vCount; i += 3) {
        const ax = pos[i*3],   ay = pos[i*3+1],   az = pos[i*3+2];
        const bx = pos[(i+1)*3], by = pos[(i+1)*3+1], bz = pos[(i+1)*3+2];
        const cx = pos[(i+2)*3], cy = pos[(i+2)*3+1], cz = pos[(i+2)*3+2];
        let nx = (ay-az)*(bz-cz)-(az-ay)*(by-cy);   // quick cross product
        let ux = bx-ax, uy = by-ay, uz = bz-az;
        let vx = cx-ax, vy = cy-ay, vz = cz-az;
        nx = uy*vz - uz*vy;
        let ny = uz*vx - ux*vz;
        let nz = ux*vy - uy*vx;
        const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
        nx /= len; ny /= len; nz /= len;
        for (let v = 0; v < 3; v++) {
          nor[(i+v)*3]   = nx;
          nor[(i+v)*3+1] = ny;
          nor[(i+v)*3+2] = nz;
        }
      }
    }

    return { pos, nor, triCount };
  }

  // ═══════════════════════════════════════════════════════════
  // EXPORT — Binary STL  (fast: typed-array DataView)
  // ═══════════════════════════════════════════════════════════
  function exportBinarySTL(geo, outputScale = 1.0) {
    const { pos, nor, triCount } = _getExportBuffers(geo, outputScale);

    const buf  = new ArrayBuffer(84 + triCount * 50);
    const view = new DataView(buf);

    // 80-byte header (ASCII, padded with zeros)
    const hdr = `DentalCAD STL Export  triangles:${triCount}  scale:${outputScale.toFixed(4)}`;
    for (let i = 0; i < 80; i++) {
      view.setUint8(i, i < hdr.length ? hdr.charCodeAt(i) : 0);
    }
    view.setUint32(80, triCount, true);

    let off = 84;
    for (let i = 0; i < triCount; i++) {
      const b = i * 9; // base index in pos/nor arrays (3 verts × 3 coords = 9)

      // Face normal — average of 3 vertex normals for smoother output
      const nx = (nor[b] + nor[b+3] + nor[b+6]) / 3;
      const ny = (nor[b+1] + nor[b+4] + nor[b+7]) / 3;
      const nz = (nor[b+2] + nor[b+5] + nor[b+8]) / 3;
      const nl = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;

      view.setFloat32(off,    nx/nl, true); off += 4;
      view.setFloat32(off,    ny/nl, true); off += 4;
      view.setFloat32(off,    nz/nl, true); off += 4;

      // 3 vertices
      for (let v = 0; v < 3; v++) {
        view.setFloat32(off,    pos[b + v*3],     true); off += 4;
        view.setFloat32(off,    pos[b + v*3 + 1], true); off += 4;
        view.setFloat32(off,    pos[b + v*3 + 2], true); off += 4;
      }
      view.setUint16(off, 0, true); off += 2; // attribute byte count
    }
    return buf;
  }

  // ═══════════════════════════════════════════════════════════
  // EXPORT — ASCII STL  (array-join for speed)
  // ═══════════════════════════════════════════════════════════
  function exportASCIISTL(geo, outputScale = 1.0) {
    const { pos, nor, triCount } = _getExportBuffers(geo, outputScale);
    const lines = [`solid DentalCAD_Export`];

    for (let i = 0; i < triCount; i++) {
      const b  = i * 9;
      const nx = (nor[b] + nor[b+3] + nor[b+6]) / 3;
      const ny = (nor[b+1] + nor[b+4] + nor[b+7]) / 3;
      const nz = (nor[b+2] + nor[b+5] + nor[b+8]) / 3;
      const nl = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;

      lines.push(
        `  facet normal ${(nx/nl).toFixed(6)} ${(ny/nl).toFixed(6)} ${(nz/nl).toFixed(6)}`,
        `    outer loop`,
        `      vertex ${pos[b].toFixed(6)} ${pos[b+1].toFixed(6)} ${pos[b+2].toFixed(6)}`,
        `      vertex ${pos[b+3].toFixed(6)} ${pos[b+4].toFixed(6)} ${pos[b+5].toFixed(6)}`,
        `      vertex ${pos[b+6].toFixed(6)} ${pos[b+7].toFixed(6)} ${pos[b+8].toFixed(6)}`,
        `    endloop`,
        `  endfacet`
      );
    }
    lines.push(`endsolid DentalCAD_Export`);
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  // EXPORT — OBJ  (with normals, groups, mtl reference)
  // ═══════════════════════════════════════════════════════════
  function exportOBJ(geo, outputScale = 1.0, mtlName = null, options = {}) {
    const { pos, nor, triCount } = _getExportBuffers(geo, outputScale);
    const vCount = triCount * 3;
    const lines  = [];

    lines.push(`# DentalCAD OBJ Export`);
    lines.push(`# Triangles: ${triCount}`);
    if (mtlName) {
      lines.push(`mtllib ${mtlName}.mtl`);
    }
    lines.push(`o DentalCAD_Model`);
    if (mtlName) lines.push(`usemtl default`);

    // Vertices
    for (let i = 0; i < vCount; i++) {
      lines.push(`v ${pos[i*3].toFixed(6)} ${pos[i*3+1].toFixed(6)} ${pos[i*3+2].toFixed(6)}`);
    }

    // Normals — deduplicate per face for compactness
    // (for simplicity, store one normal per vertex which is valid OBJ)
    for (let i = 0; i < vCount; i++) {
      lines.push(`vn ${nor[i*3].toFixed(6)} ${nor[i*3+1].toFixed(6)} ${nor[i*3+2].toFixed(6)}`);
    }

    lines.push(`s 1`);

    // Faces — 1-indexed, format: v//vn
    for (let i = 0; i < triCount; i++) {
      const a = i*3 + 1;
      lines.push(`f ${a}//${a} ${a+1}//${a+1} ${a+2}//${a+2}`);
    }

    // Optional margin annotation as a separate OBJ line object. Margin points
    // are stored in viewport coordinates, so use the same inverse import
    // transform as the mesh export.
    const margin = Array.isArray(options.marginLinePoints) ? options.marginLinePoints : [];
    if (margin.length >= 2) {
      const viewScale = geo.userData.importViewScale || 1;
      const off = geo.userData.importOffset || { x: 0, y: 0, z: 0 };
      const start = vCount + 1;
      lines.push(`g Margin_Line`);
      for (const p of margin) {
        const x = (Number(p.x) / viewScale + off.x) * outputScale;
        const y = (Number(p.y) / viewScale + off.y) * outputScale;
        const z = (Number(p.z) / viewScale + off.z) * outputScale;
        if ([x, y, z].every(Number.isFinite)) lines.push(`v ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}`);
      }
      const end = lines.length;
      const added = end - (lines.findIndex(l => l === `g Margin_Line`) + 1);
      if (added >= 2) {
        const first = start;
        const last = start + added - 1;
        lines.push(`l ${first} ${last}`);
      }
    }

    return lines.join('\n');
  }

  // Optional MTL companion string
  function exportMTL(materialName = 'default') {
    return [
      `# DentalCAD MTL Export`,
      `newmtl ${materialName}`,
      `Ka 0.800 0.760 0.680`,   // ivory ambient
      `Kd 0.930 0.880 0.820`,   // ivory diffuse
      `Ks 0.400 0.400 0.380`,   // specular
      `Ns 60.000`,
      `d 1.000`,
      `illum 2`,
    ].join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  // EXPORT — Binary PLY  (little-endian)
  // ═══════════════════════════════════════════════════════════
  function exportBinaryPLY(geo, outputScale = 1.0) {
    const { pos, nor, triCount } = _getExportBuffers(geo, outputScale);
    const vCount = triCount * 3;

    // Build header string first, then binary data
    const hasNor = nor.some(v => v !== 0);
    const headerLines = [
      `ply`,
      `format binary_little_endian 1.0`,
      `comment DentalCAD Binary PLY Export`,
      `element vertex ${vCount}`,
      `property float x`,
      `property float y`,
      `property float z`,
    ];
    if (hasNor) {
      headerLines.push(`property float nx`, `property float ny`, `property float nz`);
    }
    headerLines.push(
      `element face ${triCount}`,
      `property list uchar int vertex_index`,
      `end_header`,
      ``   // trailing newline after end_header
    );
    const headerStr  = headerLines.join('\n');
    const headerBytes = new TextEncoder().encode(headerStr);

    // Vertex record: 3 floats (xyz) + optionally 3 floats (normals)
    const floatsPerVertex = hasNor ? 6 : 3;
    const vertexBytes     = vCount * floatsPerVertex * 4;
    // Face record: 1 uchar (= 3) + 3 ints = 13 bytes
    const faceBytes       = triCount * 13;

    const buf  = new ArrayBuffer(headerBytes.byteLength + vertexBytes + faceBytes);
    const u8   = new Uint8Array(buf);
    const view = new DataView(buf);

    // Write header
    u8.set(headerBytes, 0);
    let off = headerBytes.byteLength;

    // Write vertices
    for (let i = 0; i < vCount; i++) {
      view.setFloat32(off, pos[i*3],     true); off += 4;
      view.setFloat32(off, pos[i*3+1],   true); off += 4;
      view.setFloat32(off, pos[i*3+2],   true); off += 4;
      if (hasNor) {
        view.setFloat32(off, nor[i*3],   true); off += 4;
        view.setFloat32(off, nor[i*3+1], true); off += 4;
        view.setFloat32(off, nor[i*3+2], true); off += 4;
      }
    }

    // Write faces
    for (let i = 0; i < triCount; i++) {
      view.setUint8(off, 3); off++;       // vertex count per face
      view.setInt32(off, i*3,   true); off += 4;
      view.setInt32(off, i*3+1, true); off += 4;
      view.setInt32(off, i*3+2, true); off += 4;
    }

    return buf;
  }

  // ═══════════════════════════════════════════════════════════
  // EXPORT — ASCII PLY
  // ═══════════════════════════════════════════════════════════
  function exportASCIIPLY(geo, outputScale = 1.0) {
    const { pos, nor, triCount } = _getExportBuffers(geo, outputScale);
    const vCount  = triCount * 3;
    const hasNor  = nor.some(v => v !== 0);
    const lines   = [
      `ply`,
      `format ascii 1.0`,
      `comment DentalCAD ASCII PLY Export`,
      `element vertex ${vCount}`,
      `property float x`,
      `property float y`,
      `property float z`,
      ...(hasNor ? [`property float nx`, `property float ny`, `property float nz`] : []),
      `element face ${triCount}`,
      `property list uchar int vertex_index`,
      `end_header`,
    ];

    for (let i = 0; i < vCount; i++) {
      let line = `${pos[i*3].toFixed(6)} ${pos[i*3+1].toFixed(6)} ${pos[i*3+2].toFixed(6)}`;
      if (hasNor) line += ` ${nor[i*3].toFixed(6)} ${nor[i*3+1].toFixed(6)} ${nor[i*3+2].toFixed(6)}`;
      lines.push(line);
    }
    for (let i = 0; i < triCount; i++) {
      lines.push(`3 ${i*3} ${i*3+1} ${i*3+2}`);
    }
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════
  // EXPORT — 3MF package (ZIP store, no external dependency)
  // ═══════════════════════════════════════════════════════════
  function export3MFModel(geo, outputScale = 1.0) {
    const { pos, nor, triCount } = _getExportBuffers(geo, outputScale);
    const vCount = triCount * 3;

    const vLines = [];
    for (let i = 0; i < vCount; i++) {
      vLines.push(`        <vertex x="${pos[i*3].toFixed(6)}" y="${pos[i*3+1].toFixed(6)}" z="${pos[i*3+2].toFixed(6)}"/>`);
    }
    const tLines = [];
    for (let i = 0; i < triCount; i++) {
      tLines.push(`        <triangle v1="${i*3}" v2="${i*3+1}" v3="${i*3+2}"/>`);
    }

    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<model unit="millimeter" xml:lang="en-US"`,
      `  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`,
      `  <metadata name="Title">DentalCAD Export</metadata>`,
      `  <metadata name="Application">DentalCAD Web</metadata>`,
      `  <resources>`,
      `    <object id="1" type="model">`,
      `      <mesh>`,
      `        <vertices>`,
      ...vLines,
      `        </vertices>`,
      `        <triangles>`,
      ...tLines,
      `        </triangles>`,
      `      </mesh>`,
      `    </object>`,
      `  </resources>`,
      `  <build>`,
      `    <item objectid="1"/>`,
      `  </build>`,
      `</model>`,
    ].join('\n');
  }

  function _crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function export3MFPackage(geo, outputScale = 1.0) {
    const files = [
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'],
      ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3d/2013/01/3dmodel"/></Relationships>'],
      ['3D/3dmodel.model', export3MFModel(geo, outputScale)],
    ].map(([name, text]) => ({ nameBytes: new TextEncoder().encode(name), data: new TextEncoder().encode(text) }));
    const local = [], central = [];
    let offset = 0;
    const u16 = (v) => { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, v, true); return a; };
    const u32 = (v) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v >>> 0, true); return a; };
    const join = (parts) => { const size = parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(size); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
    for (const file of files) {
      const crc = _crc32(file.data), n = file.nameBytes.length, size = file.data.length;
      const header = join([new Uint8Array([0x50,0x4b,0x03,0x04]), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(n), u16(0), file.nameBytes]);
      local.push(header, file.data);
      const directory = join([new Uint8Array([0x50,0x4b,0x01,0x02]), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(size), u32(size), u16(n), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), file.nameBytes]);
      central.push(directory);
      offset += header.length + size;
    }
    const centralBytes = join(central);
    const end = join([new Uint8Array([0x50,0x4b,0x05,0x06]), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralBytes.length), u32(offset), u16(0)]);
    return join([...local, centralBytes, end]).buffer;
  }

  // ═══════════════════════════════════════════════════════════
  // SIZE ESTIMATE  (bytes, approximate, before compression)
  // ═══════════════════════════════════════════════════════════
  function estimateExportSize(geo, format) {
    const triCount = Math.floor((geo.getAttribute('position')?.count || 0) / 3);
    switch (format) {
      case 'STL Binary': return 84 + triCount * 50;
      case 'STL ASCII':  return triCount * 220;   // ~220 chars per facet
      case 'OBJ':        return triCount * 280;
      case 'PLY Binary': return 500 + triCount * 3 * (12 + 12) + triCount * 13;
      case 'PLY ASCII':  return triCount * 200;
      case '3MF':        return triCount * 200;
      default:           return triCount * 50;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // FORMAT SIZE LABEL
  // ═══════════════════════════════════════════════════════════
  function formatBytes(bytes) {
    if (bytes < 1024)        return `${bytes} B`;
    if (bytes < 1048576)     return `${(bytes/1024).toFixed(1)} KB`;
    if (bytes < 1073741824)  return `${(bytes/1048576).toFixed(2)} MB`;
    return `${(bytes/1073741824).toFixed(2)} GB`;
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════
  return {
    LIMITS: Object.freeze({ MAX_SCAN_BYTES, MAX_TRIANGLES }),
    parseFile,
    exportBinarySTL,
    exportASCIISTL,
    exportOBJ,
    exportMTL,
    exportBinaryPLY,
    exportASCIIPLY,
    export3MFModel,
    export3MFPackage,
    estimateExportSize,
    formatBytes,
  };
})();

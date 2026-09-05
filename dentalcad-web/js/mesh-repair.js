/**
 * mesh-repair.js — deterministic triangle-mesh cleanup utilities.
 *
 * This is a conservative surface cleanup pass. It does not invent missing
 * anatomy or fill holes; it removes duplicate vertices/faces and degenerate
 * triangles while preserving the represented surface.
 */
const MeshRepair = (() => {
  function _position(geometry) {
    const attr = geometry?.getAttribute?.('position');
    if (!attr?.count || attr.count % 3 !== 0) throw new Error('Mesh must contain complete triangles');
    for (const value of attr.array) if (!Number.isFinite(value)) throw new Error('Mesh contains non-finite coordinates');
    return attr;
  }

  function analyze(geometry, opts = {}) {
    const pos = _position(geometry);
    const tolerance = Number(opts.tolerance ?? 1e-5);
    const areaEpsilon = Number(opts.areaEpsilon ?? 1e-12);
    if (!Number.isFinite(tolerance) || tolerance <= 0 || !Number.isFinite(areaEpsilon) || areaEpsilon < 0) throw new Error('Invalid mesh repair tolerances');
    const seen = new Set();
    let degenerateTriangles = 0, duplicateFaces = 0;
    const key = (x, y, z) => `${Math.round(x / tolerance)},${Math.round(y / tolerance)},${Math.round(z / tolerance)}`;
    const vertices = new Map();
    const point = i => [pos.getX(i), pos.getY(i), pos.getZ(i)];
    for (let i = 0; i < pos.count; i += 3) {
      const ids = [i, i + 1, i + 2].map(v => { const p = point(v), k = key(...p); if (!vertices.has(k)) vertices.set(k, vertices.size); return vertices.get(k); });
      if (new Set(ids).size < 3) { degenerateTriangles++; continue; }
      const a = new THREE.Vector3(...point(i)), b = new THREE.Vector3(...point(i + 1)), c = new THREE.Vector3(...point(i + 2));
      if (b.clone().sub(a).cross(c.clone().sub(a)).lengthSq() <= areaEpsilon) { degenerateTriangles++; continue; }
      const face = ids.slice().sort((x, y) => x - y).join(':');
      if (seen.has(face)) duplicateFaces++; else seen.add(face);
    }
    return { vertexCount: pos.count, uniqueVertexCount: vertices.size, triangleCount: pos.count / 3, degenerateTriangles, duplicateFaces, tolerance, areaEpsilon };
  }

  function repair(geometry, opts = {}) {
    const pos = _position(geometry);
    const tolerance = Number(opts.tolerance ?? 1e-5);
    const areaEpsilon = Number(opts.areaEpsilon ?? 1e-12);
    if (!Number.isFinite(tolerance) || tolerance <= 0 || !Number.isFinite(areaEpsilon) || areaEpsilon < 0) throw new Error('Invalid mesh repair tolerances');
    const representatives = new Map(), sums = [], counts = [], indices = [], faces = new Set();
    const key = (x, y, z) => `${Math.round(x / tolerance)},${Math.round(y / tolerance)},${Math.round(z / tolerance)}`;
    const vertexId = (x, y, z) => { const k = key(x, y, z); let id = representatives.get(k); if (id == null) { id = sums.length; representatives.set(k, id); sums.push([x, y, z]); counts.push(1); } else { sums[id][0] += x; sums[id][1] += y; sums[id][2] += z; counts[id]++; } return id; };
    let removedDegenerate = 0, removedDuplicateFaces = 0;
    for (let i = 0; i < pos.count; i += 3) {
      const ids = [0, 1, 2].map(j => vertexId(pos.getX(i + j), pos.getY(i + j), pos.getZ(i + j)));
      const a = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)), b = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)), c = new THREE.Vector3(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
      const face = ids.slice().sort((x, y) => x - y).join(':');
      if (new Set(ids).size < 3 || b.clone().sub(a).cross(c.clone().sub(a)).lengthSq() <= areaEpsilon) { removedDegenerate++; continue; }
      if (faces.has(face)) { removedDuplicateFaces++; continue; }
      faces.add(face); indices.push(...ids);
    }
    const vertices = new Float32Array(sums.length * 3);
    sums.forEach((p, i) => { vertices[i * 3] = p[0] / counts[i]; vertices[i * 3 + 1] = p[1] / counts[i]; vertices[i * 3 + 2] = p[2] / counts[i]; });
    const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(vertices, 3)); out.setIndex(indices); out.computeVertexNormals();
    out.userData = { ...(geometry.userData || {}), meshRepair: { tolerance, areaEpsilon } };
    return { geometry: out, report: { inputVertices: pos.count, inputTriangles: pos.count / 3, outputVertices: sums.length, outputTriangles: indices.length / 3, weldedVertices: pos.count - sums.length, removedDegenerate, removedDuplicateFaces, changed: pos.count !== sums.length || removedDegenerate > 0 || removedDuplicateFaces > 0 } };
  }

  return { analyze, repair };
})();
window.MeshRepair = MeshRepair;

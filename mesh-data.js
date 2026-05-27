import * as THREE from 'three';
/**
 * MeshData — pure data layer.
 *
 * Owns:
 *   • a reference to the target THREE.BufferGeometry (reads/writes position buffer)
 *   • topology: edge map, face list, quad-diagonal flags
 *   • selection sets (vertex indices, edge keys, face indices)
 *   • undo stack (snapshots of position buffer)
 *
 * Zero Three.js scene objects created here. No rendering, no DOM.
 * Consumers call mutate*() to change geometry, then read dirty flags
 * to know what the render layer needs to update.
 */

export class MeshData {
  constructor(mesh) {
    this.mesh    = mesh;         // THREE.Mesh — read matrixWorld, geometry
    this.geo     = mesh.geometry;
    this.pos     = this.geo.attributes.position;

    // Selection
    this.selVerts = new Set();
    this.selEdges = new Set();
    this.selFaces = new Set();
    this.subMode  = 'vertex';    // 'vertex' | 'edge' | 'face'

    // Topology (rebuilt lazily when geometry changes)
    this.edgeMap    = new Map(); // edgeKey → { a, b, faceCount, faces[] }
    this.faceCount  = 0;
    this.quadGroups = [];        // logical face groups (quads) for face mode
    this._isQuadDiag = null;     // (edgeEntry) => bool, set during buildTopology

    // Snap (undo managed externally by History)
    this._preSnap = null;  // Float32Array snapshot taken at drag-start

    // Dirty flags — render layer checks these every frame, clears after consuming
    this.dirty = {
      topology   : true,  // edge map / face list needs rebuild
      positions  : true,  // vertex positions changed → upload to GPU
      selection  : true,  // selection colours changed → recolour buffers
    };

    this._buildTopology();
  }

  // ─────────────────────────────────────────────────────────── topology ──

  _buildTopology() {
    const geo   = this.geo;
    const pos   = this.pos;
    const index = geo.index;

    this.edgeMap   = new Map();
    this.faceCount = index ? index.count / 3 | 0 : pos.count / 3 | 0;

    const addEdge = (a, b, fi) => {
      const k = edgeKey(a, b);
      if (!this.edgeMap.has(k)) this.edgeMap.set(k, { a, b, faceCount: 0, faces: [] });
      const e = this.edgeMap.get(k);
      e.faceCount++;
      e.faces.push(fi);
    };

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const fi = i / 3 | 0;
        const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
        addEdge(a, b, fi); addEdge(b, c, fi); addEdge(c, a, fi);
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        const fi = i / 3 | 0;
        addEdge(i, i + 1, fi); addEdge(i + 1, i + 2, fi); addEdge(i + 2, i, fi);
      }
    }

    // Pre-compute quad-diagonal lookup (shared by render + interaction)
    this._isQuadDiag = (e) => {
      if (e.faceCount !== 2 || !index) return false;
      const tv  = fi => [index.getX(fi * 3), index.getX(fi * 3 + 1), index.getX(fi * 3 + 2)];
      const t0  = tv(e.faces[0]), t1 = tv(e.faces[1]);
      const all = [...new Set([...t0, ...t1])];
      if (all.length !== 4) return false;
      const vp = i => { const p = this.pos; return { x: p.getX(i), y: p.getY(i), z: p.getZ(i) }; };
      const va = vp(t0[0]);
      // normal of first tri
      const ab = sub3(vp(t0[1]), va), ac = sub3(vp(t0[2]), va);
      const n  = cross3(ab, ac);
      const len = Math.hypot(n.x, n.y, n.z);
      if (len < 1e-10) return false;
      n.x /= len; n.y /= len; n.z /= len;
      const vd = vp(all.find(v => !t0.includes(v)));
      const dd = sub3(vd, va);
      return Math.abs(n.x * dd.x + n.y * dd.y + n.z * dd.z) < 0.002;
    };

    // Build logical quad groups for face selection
    this.quadGroups = buildQuadGroups(this.geo);
    this.faceCount  = this.quadGroups.length;  // expose quad count, not tri count

    this.dirty.topology = false;
  }

  rebuildTopology() {
    this._buildTopology();
    this.dirty.topology = false;
  }

  // ─────────────────────────────────────────────────────── selection API ──

  setSubMode(mode) {
    this.subMode = mode;
    if (mode !== 'vertex') this.selVerts.clear();
    if (mode !== 'edge')   this.selEdges.clear();
    if (mode !== 'face')   this.selFaces.clear();
    this.dirty.selection = true;
  }

  selectVert(vi, additive) {
    if (!additive) this.selVerts.clear();
    if (additive && this.selVerts.has(vi)) this.selVerts.delete(vi);
    else this.selVerts.add(vi);
    this.dirty.selection = true;
  }

  selectEdge(key, additive) {
    if (!additive) this.selEdges.clear();
    if (additive && this.selEdges.has(key)) this.selEdges.delete(key);
    else this.selEdges.add(key);
    this.dirty.selection = true;
  }

  selectFace(fi, additive) {
    if (!additive) this.selFaces.clear();
    if (additive && this.selFaces.has(fi)) this.selFaces.delete(fi);
    else this.selFaces.add(fi);
    this.dirty.selection = true;
  }

  clearSelection() {
    this.selVerts.clear();
    this.selEdges.clear();
    this.selFaces.clear();
    this.dirty.selection = true;
  }

  toggleSelectAll() {
    const pos   = this.pos;
    const index = this.geo.index;
    if (this.subMode === 'vertex') {
      if (this.selVerts.size === pos.count) this.selVerts.clear();
      else for (let i = 0; i < pos.count; i++) this.selVerts.add(i);
    } else if (this.subMode === 'edge') {
      const visibleEdges = [...this.edgeMap.entries()]
        .filter(([, e]) => !this._isQuadDiag(e))
        .map(([k]) => k);
      if (this.selEdges.size === visibleEdges.length) this.selEdges.clear();
      else visibleEdges.forEach(k => this.selEdges.add(k));
    } else if (this.subMode === 'face') {
      const total = this.quadGroups.length;
      if (this.selFaces.size === total) this.selFaces.clear();
      else for (let i = 0; i < total; i++) this.selFaces.add(i);
    }
    this.dirty.selection = true;
  }

  // Returns Set of vertex buffer indices that are "active" given current subMode + selection
  selectedVertIndices() {
    const out   = new Set();
    const index = this.geo.index;
    if (this.subMode === 'vertex') {
      this.selVerts.forEach(i => out.add(i));
    } else if (this.subMode === 'edge') {
      this.selEdges.forEach(k => {
        const [a, b] = k.split('_').map(Number);
        out.add(a); out.add(b);
      });
    } else if (this.subMode === 'face') {
      this.selFaces.forEach(gi => {
        if (this.quadGroups[gi]) this.quadGroups[gi].verts.forEach(vi => out.add(vi));
      });
    }
    return out;
  }

  // ─────────────────────────────────────────────────────── undo / snap ──

  // Take a snapshot of the current position buffer (call before any drag/mutation)
  saveSnap() {
    this._preSnap = new Float32Array(this.pos.array);
  }

  // Returns { snapBefore, snapAfter } for pushing to History, then clears _preSnap.
  // Returns null if no snap was saved.
  takeSnap() {
    if (!this._preSnap) return null;
    const before = this._preSnap;
    const after  = new Float32Array(this.pos.array);
    this._preSnap = null;
    return { snapBefore: before, snapAfter: after };
  }

  discardSnap() {
    this._preSnap = null;
  }

  // Restore geometry from a raw Float32Array snapshot (called by History)
  restoreSnap(snap) {
    const pos = this.pos;
    pos.array.set(snap);
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.dirty.positions = true;
    this.dirty.selection = true;
    this.rebuildTopology();
  }

  // ─────────────────────────────────────────────────────── mutations ──

  /**
   * Apply a world-space delta to a set of vertex indices, each weighted 0–1.
   * weights: Map<vertIndex, weight>  (weight=1 = full move, weight=0 = no move)
   * snapBase: Float32Array snapshot to compute delta from (this._preSnap)
   */
  applyWeightedDelta(worldDelta, weights) {
    if (!this._preSnap) return;
    const pos    = this.pos;
    const invMat = this.mesh.matrixWorld.clone().invert();

    // Convert world-space delta to local (correct: p1 - p0 through invMat)
    const p0 = { x: 0, y: 0, z: 0 };
    const p1 = { x: worldDelta.x, y: worldDelta.y, z: worldDelta.z };
    const lp0 = applyMat4(p0, invMat);
    const lp1 = applyMat4(p1, invMat);
    const lx = lp1.x - lp0.x;
    const ly = lp1.y - lp0.y;
    const lz = lp1.z - lp0.z;

    const snap = this._preSnap;
    weights.forEach((w, i) => {
      const base = i * 3;
      pos.array[base]     = snap[base]     + lx * w;
      pos.array[base + 1] = snap[base + 1] + ly * w;
      pos.array[base + 2] = snap[base + 2] + lz * w;
    });

    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.dirty.positions = true;
    this.dirty.selection = true; // overlay positions must follow
  }

  /**
   * Build a weight map for proportional editing.
   * selected: Set<vertIndex> — these get weight 1.0
   * radius: world-space influence radius
   * Returns Map<vertIndex, weight>
   */
  buildPropWeights(selected, radius) {
    const weights = new Map();
    const pos     = this.pos;
    const mat     = this.mesh.matrixWorld;
    const snap    = this._preSnap;
    if (!snap) return weights;

    // World positions of selected verts (from snapshot)
    const selWorld = [];
    selected.forEach(i => {
      selWorld.push(applyMat4raw(snap[i * 3], snap[i * 3 + 1], snap[i * 3 + 2], mat));
    });

    const total = pos.count;
    for (let i = 0; i < total; i++) {
      if (selected.has(i)) { weights.set(i, 1.0); continue; }
      const vw = applyMat4raw(snap[i * 3], snap[i * 3 + 1], snap[i * 3 + 2], mat);
      let minDist = Infinity;
      for (const sw of selWorld) {
        const d = dist3(vw, sw);
        if (d < minDist) minDist = d;
      }
      const w = smoothFalloff(minDist, radius);
      if (w > 1e-6) weights.set(i, w);
    }
    return weights;
  }

  // World position of vertex i (reads live position buffer + mesh transform)
  vertWorldPos(i) {
    return applyMat4raw(
      this.pos.getX(i), this.pos.getY(i), this.pos.getZ(i),
      this.mesh.matrixWorld
    );
  }

  // Centroid of selected verts in world space
  selectionCentroid() {
    const vis = this.selectedVertIndices();
    if (!vis.size) return null;
    let x = 0, y = 0, z = 0;
    vis.forEach(i => {
      const w = this.vertWorldPos(i);
      x += w.x; y += w.y; z += w.z;
    });
    const n = vis.size;
    return { x: x / n, y: y / n, z: z / n };
  }
}

// ── Pure math helpers (no THREE dependency) ──────────────────────────────

export function edgeKey(a, b) { return a < b ? `${a}_${b}` : `${b}_${a}`; }

function sub3(a, b)   { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function cross3(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Blender "Smooth" falloff: w = (1 - (d/r)^2)^2
function smoothFalloff(d, r) {
  if (d >= r) return 0;
  const t = d / r;
  return (1 - t * t) * (1 - t * t);
}

// Minimal 4x4 matrix multiply for a point {x,y,z} — avoids THREE.Vector3 alloc
function applyMat4(p, m) {
  const e = m.elements;
  const w = 1 / (e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15]);
  return {
    x: (e[0] * p.x + e[4] * p.y + e[8]  * p.z + e[12]) * w,
    y: (e[1] * p.x + e[5] * p.y + e[9]  * p.z + e[13]) * w,
    z: (e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14]) * w,
  };
}

function applyMat4raw(x, y, z, m) {
  const e = m.elements;
  const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
  return {
    x: (e[0] * x + e[4] * y + e[8]  * z + e[12]) * w,
    y: (e[1] * x + e[5] * y + e[9]  * z + e[13]) * w,
    z: (e[2] * x + e[6] * y + e[10] * z + e[14]) * w,
  };
}

// ── Quad grouping ─────────────────────────────────────────────────────────
// Groups coplanar adjacent triangle pairs into logical "quads" for face mode.
// Returns array of { tris: [fi, ...], verts: [vi, ...], normal: {x,y,z} }
// Each group is what the user sees and selects as one face.
export function buildQuadGroups(geo) {
  const pos   = geo.attributes.position;
  const index = geo.index;
  if (!index) return [];

  const fc = index.count / 3 | 0;

  // Compute per-triangle normal
  const triNormal = (fi) => {
    const a = index.getX(fi*3), b = index.getX(fi*3+1), c = index.getX(fi*3+2);
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b) - ax, by = pos.getY(b) - ay, bz = pos.getZ(b) - az;
    const cx = pos.getX(c) - ax, cy = pos.getY(c) - ay, cz = pos.getZ(c) - az;
    const nx = by*cz - bz*cy, ny = bz*cx - bx*cz, nz = bx*cy - by*cx;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx/len, y: ny/len, z: nz/len };
  };

  // Edge → triangles map
  const edgeTris = new Map();
  for (let fi = 0; fi < fc; fi++) {
    for (let j = 0; j < 3; j++) {
      const a = index.getX(fi*3+j), b = index.getX(fi*3+(j+1)%3);
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!edgeTris.has(k)) edgeTris.set(k, []);
      edgeTris.get(k).push(fi);
    }
  }

  // Union-Find for coplanar triangle merging
  const parent = Array.from({length: fc}, (_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { parent[find(a)] = find(b); };

  const normals = Array.from({length: fc}, (_, i) => triNormal(i));
  const COPLANAR = 0.9998; // ~1 degree tolerance

  edgeTris.forEach(tris => {
    if (tris.length !== 2) return;
    const [fa, fb] = tris;
    const na = normals[fa], nb = normals[fb];
    const dot = na.x*nb.x + na.y*nb.y + na.z*nb.z;
    if (Math.abs(dot) > COPLANAR) union(fa, fb);
  });

  // Group triangles by root
  const groups = new Map();
  for (let fi = 0; fi < fc; fi++) {
    const r = find(fi);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(fi);
  }

  return [...groups.values()].map(tris => {
    const verts = [...new Set(tris.flatMap(fi => [
      index.getX(fi*3), index.getX(fi*3+1), index.getX(fi*3+2)
    ]))];
    const n = normals[tris[0]];
    return { tris, verts, normal: n };
  });
}

// ── Extrude faces ─────────────────────────────────────────────────────────
// Blender-style region extrude:
//   1. Original selected-face verts stay in place → become the side-wall base
//   2. New duplicated verts placed at distance along normal → become the cap
//   3. Non-selected faces are untouched (keep original indices)
//   4. Selected faces remap to the duplicated (cap) verts
//   5. Boundary edges get quad side-walls stitching base → cap
export function extrudeFaces(geo, selectedGroups, quadGroups, distance = 0) {
  const oldPos   = geo.attributes.position;
  const oldIndex = geo.index;
  if (!oldIndex) return geo;

  const fc = oldIndex.count / 3 | 0;

  // Collect triangle indices belonging to selected groups
  const selTris = new Set();
  selectedGroups.forEach(gi => {
    if (quadGroups[gi]) quadGroups[gi].tris.forEach(fi => selTris.add(fi));
  });

  // Collect unique vertex indices used by selected faces
  const selVerts = new Set();
  selTris.forEach(fi => {
    selVerts.add(oldIndex.getX(fi * 3));
    selVerts.add(oldIndex.getX(fi * 3 + 1));
    selVerts.add(oldIndex.getX(fi * 3 + 2));
  });

  // Average extrude normal from selected groups
  let nx = 0, ny = 0, nz = 0;
  selectedGroups.forEach(gi => {
    if (!quadGroups[gi]) return;
    const n = quadGroups[gi].normal;
    nx += n.x; ny += n.y; nz += n.z;
  });
  const nlen = Math.hypot(nx, ny, nz) || 1;
  nx /= nlen; ny /= nlen; nz /= nlen;

  // New position buffer:
  //   [0 .. oldCount-1]          = all original verts (unchanged)
  //   [oldCount .. oldCount+N-1] = duplicated cap verts (pushed along normal)
  const oldCount  = oldPos.count;
  const newCount  = oldCount + selVerts.size;
  const newPosArr = new Float32Array(newCount * 3);

  // Copy every original vert unchanged
  for (let i = 0; i < oldCount * 3; i++) newPosArr[i] = oldPos.array[i];

  // Duplicate selected verts → cap (offset by distance along normal)
  const oldToNew = new Map(); // old vi → new (cap) vi
  let insertIdx  = oldCount;
  selVerts.forEach(vi => {
    oldToNew.set(vi, insertIdx);
    newPosArr[insertIdx * 3]     = oldPos.getX(vi) + nx * distance;
    newPosArr[insertIdx * 3 + 1] = oldPos.getY(vi) + ny * distance;
    newPosArr[insertIdx * 3 + 2] = oldPos.getZ(vi) + nz * distance;
    insertIdx++;
  });

  // Build index array
  // Non-selected faces → original indices (base stays closed)
  // Selected faces     → remapped to cap indices
  const newTriangles = [];

  for (let fi = 0; fi < fc; fi++) {
    const a = oldIndex.getX(fi * 3);
    const b = oldIndex.getX(fi * 3 + 1);
    const c = oldIndex.getX(fi * 3 + 2);
    if (selTris.has(fi)) {
      // Cap face — use duplicated verts
      newTriangles.push(oldToNew.get(a), oldToNew.get(b), oldToNew.get(c));
    } else {
      // Unselected face — keep as-is
      newTriangles.push(a, b, c);
    }
  }

  // Side walls — fast O(n) approach with a directed-edge map.
  // For every edge walked in winding order (a→b), store which face owns it.
  // A boundary edge is one where the directed edge a→b belongs to a selected tri
  // but b→a is NOT owned by another selected tri (i.e. it borders an unselected
  // face or is a mesh border). These edges get a quad wall.
  const dirEdgeOwner = new Map(); // "a_b" → fi (directed)
  for (let fi = 0; fi < fc; fi++) {
    for (let j = 0; j < 3; j++) {
      const a = oldIndex.getX(fi * 3 + j);
      const b = oldIndex.getX(fi * 3 + (j + 1) % 3);
      dirEdgeOwner.set(`${a}_${b}`, fi);
    }
  }

  for (let fi = 0; fi < fc; fi++) {
    if (!selTris.has(fi)) continue;
    for (let j = 0; j < 3; j++) {
      const a  = oldIndex.getX(fi * 3 + j);
      const b  = oldIndex.getX(fi * 3 + (j + 1) % 3);
      // The opposite directed edge b→a
      const oppOwner = dirEdgeOwner.get(`${b}_${a}`);
      // Boundary = opposite edge not owned by a selected tri
      if (oppOwner !== undefined && selTris.has(oppOwner)) continue;
      const na2 = oldToNew.get(a);
      const nb2 = oldToNew.get(b);
      if (na2 === undefined || nb2 === undefined) continue;
      // Quad wall stitching base (a,b) to cap (na2,nb2)
      // Winding follows selected-face outward normal
      newTriangles.push(a,  nb2, b  );
      newTriangles.push(a,  na2, nb2);
    }
  }

  const newGeo = geo.clone();
  newGeo.setAttribute('position', new THREE.Float32BufferAttribute(newPosArr, 3));
  newGeo.setIndex(newTriangles);
  newGeo.computeVertexNormals();
  return newGeo;
}

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
    this._isQuadDiag = null;     // (edgeEntry) => bool, set during buildTopology

    // Undo
    this._undoStack = [];
    this._preSnap   = null;      // snapshot taken at drag-start

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
    } else if (this.subMode === 'face' && index) {
      const total = this.faceCount;
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
    } else if (this.subMode === 'face' && index) {
      this.selFaces.forEach(fi => {
        out.add(index.getX(fi * 3));
        out.add(index.getX(fi * 3 + 1));
        out.add(index.getX(fi * 3 + 2));
      });
    }
    return out;
  }

  // ─────────────────────────────────────────────────────── undo / snap ──

  saveSnap() {
    const pos = this.pos;
    this._preSnap = new Float32Array(pos.array); // raw copy — fast, no object alloc
  }

  commitSnap() {
    if (this._preSnap) {
      this._undoStack.push(this._preSnap);
      this._preSnap = null;
    }
  }

  discardSnap() {
    this._preSnap = null;
  }

  undo() {
    if (!this._undoStack.length) return false;
    const snap = this._undoStack.pop();
    const pos  = this.pos;
    // Raw Float32Array restore — fastest possible
    for (let i = 0; i < snap.length; i++) pos.array[i] = snap[i];
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.dirty.positions = true;
    this.dirty.selection = true;
    this.rebuildTopology();
    return true;
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

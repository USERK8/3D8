import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// ── Constants (Blender-like defaults) ─────────────────────────────────────────
const COLOR = {
  VERT_IDLE : 0x222222,
  VERT_SEL  : 0xff8800,   // Blender orange
  VERT_HOVER: 0xffffff,
  EDGE_IDLE : 0x333333,
  EDGE_SEL  : 0xff8800,
  FACE_IDLE_OP  : 0.00,
  FACE_SEL_COLOR: 0xff8800,
  FACE_SEL_OP   : 0.30,
};

const VERT_RADIUS   = 0.028;
const PICK_THRESH   = 0.055;   // world-space radius for edge/vert picking
const PROP_RADIUS   = 1.6;     // proportional-edit falloff radius
const GIZMO_SIZE    = 0.75;

// ── Helpers ───────────────────────────────────────────────────────────────────
function edgeKey(a, b) { return a < b ? `${a}_${b}` : `${b}_${a}`; }

function getWorldVert(posAttr, i, matWorld) {
  return new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(matWorld);
}

// Smooth-step weight  0→1 as dist goes PROP_RADIUS→0
function smoothWeight(dist, radius) {
  if (dist >= radius) return 0;
  const t = dist / radius;
  return 1 - t * t * (3 - 2 * t);
}

// ── Main class ────────────────────────────────────────────────────────────────
export class MeshEditor {
  constructor(scene, camera, renderer, orbitControls) {
    this.scene    = scene;
    this.camera   = camera;
    this.renderer = renderer;
    this.orbit    = orbitControls;

    this.targetMesh = null;
    this.subMode    = 'vertex';   // 'vertex' | 'edge' | 'face'

    // Selection state
    this.selVerts = new Set();   // vertex indices
    this.selEdges = new Set();   // edge keys  "a_b"
    this.selFaces = new Set();   // face indices

    // Undo
    this._undoStack  = [];
    this._preSnap    = null;

    // Internal bookkeeping rebuilt each frame helpers are refreshed
    this._vertMeshes  = [];      // THREE.Mesh per vertex
    this._edgeEntries = [];      // [{key, a, b, line}]
    this._faceMeshes  = [];      // THREE.Mesh per face
    this._edgeLineSet = null;    // single LineSegments object

    // Overlay groups
    this._grpVert = new THREE.Group();
    this._grpEdge = new THREE.Group();
    this._grpFace = new THREE.Group();
    scene.add(this._grpVert, this._grpEdge, this._grpFace);

    // Raycaster
    this._rc = new THREE.Raycaster();
    this._rc.params.Line.threshold = 0.04;

    // Gizmo – attach to a proxy object so we control position explicitly
    this._proxy     = new THREE.Object3D();
    this._proxyPrev = new THREE.Vector3();
    scene.add(this._proxy);

    this._gizmo = new TransformControls(camera, renderer.domElement);
    this._gizmo.setMode('translate');
    this._gizmo.setSize(GIZMO_SIZE);
    scene.add(this._gizmo);

    // Gizmo events
    this._gizmo.addEventListener('mouseDown', () => {
      this.orbit.enabled = false;
      this._saveSnap();
      this._proxyPrev.copy(this._proxy.position);
    });
    this._gizmo.addEventListener('mouseUp', () => {
      this.orbit.enabled = true;
      this._commitSnap();
      this._reanchorGizmo();
    });
    this._gizmo.addEventListener('change', () => {
      if (!this._gizmo.dragging) return;
      this._applyGizmoDelta();
    });

    // Box-select state
    this._box = { active: false, start: null, div: null };

    // Bind handlers
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp   = this._onPointerUp.bind(this);
    this._onKeyDown     = this._onKeyDown.bind(this);
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  enter(mesh) {
    this.targetMesh = mesh;
    this.subMode    = 'vertex';
    this.selVerts.clear(); this.selEdges.clear(); this.selFaces.clear();
    this._undoStack = [];
    this._refresh();
    this._hideGizmo();

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this._onPointerDown);
    el.addEventListener('pointermove', this._onPointerMove);
    el.addEventListener('pointerup',   this._onPointerUp);
    window.addEventListener('keydown', this._onKeyDown);
  }

  exit() {
    this._clear();
    this._hideGizmo();
    this.targetMesh = null;
    this.selVerts.clear(); this.selEdges.clear(); this.selFaces.clear();

    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerup',   this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
    this._endBoxSelect();
  }

  setSubMode(mode) {
    this.subMode = mode;
    if (mode !== 'vertex') this.selVerts.clear();
    if (mode !== 'edge')   this.selEdges.clear();
    if (mode !== 'face')   this.selFaces.clear();
    this._refresh();
    this._updateGizmo();
  }

  undo() {
    if (!this._undoStack.length) return false;
    const snap = this._undoStack.pop();
    const pos  = this.targetMesh.geometry.attributes.position;
    snap.forEach((v, i) => pos.setXYZ(i, v.x, v.y, v.z));
    pos.needsUpdate = true;
    this.targetMesh.geometry.computeVertexNormals();
    this._refresh();
    this._updateGizmo();
    return true;
  }

  // ── Undo ─────────────────────────────────────────────────────────────────────
  _saveSnap() {
    const pos = this.targetMesh.geometry.attributes.position;
    this._preSnap = Array.from({ length: pos.count },
      (_, i) => new THREE.Vector3().fromBufferAttribute(pos, i));
  }
  _commitSnap() {
    if (this._preSnap) { this._undoStack.push(this._preSnap); this._preSnap = null; }
  }

  // ── Gizmo ────────────────────────────────────────────────────────────────────
  _showGizmo(worldPos) {
    this._proxy.position.copy(worldPos);
    this._proxyPrev.copy(worldPos);
    this._gizmo.attach(this._proxy);
  }
  _hideGizmo() { this._gizmo.detach(); }

  _reanchorGizmo() {
    const c = this._centroid();
    if (c) this._showGizmo(c); else this._hideGizmo();
  }

  _updateGizmo() {
    const c = this._centroid();
    c ? this._showGizmo(c) : this._hideGizmo();
  }

  _centroid() {
    const vis = this._selectedVertIndices();
    if (!vis.size) return null;
    const pos = this.targetMesh.geometry.attributes.position;
    const mat = this.targetMesh.matrixWorld;
    const c   = new THREE.Vector3();
    vis.forEach(i => c.add(getWorldVert(pos, i, mat)));
    return c.divideScalar(vis.size);
  }

  _selectedVertIndices() {
    const out   = new Set();
    const geo   = this.targetMesh?.geometry;
    const index = geo?.index;
    if (this.subMode === 'vertex') {
      this.selVerts.forEach(i => out.add(i));
    } else if (this.subMode === 'edge') {
      this.selEdges.forEach(k => {
        const [a, b] = k.split('_').map(Number);
        out.add(a); out.add(b);
      });
    } else if (this.subMode === 'face' && index) {
      this.selFaces.forEach(fi => {
        out.add(index.getX(fi*3));
        out.add(index.getX(fi*3+1));
        out.add(index.getX(fi*3+2));
      });
    }
    return out;
  }

  // ── Movement ──────────────────────────────────────────────────────────────────
  _applyGizmoDelta() {
    const rawDelta = this._proxy.position.clone().sub(this._proxyPrev);
    if (rawDelta.lengthSq() < 1e-16) return;
    this._proxyPrev.copy(this._proxy.position);

    const pos      = this.targetMesh.geometry.attributes.position;
    const mat      = this.targetMesh.matrixWorld;
    const invMat   = mat.clone().invert();
    // Convert world delta → local delta (direction only, no scale distortion)
    const localDelta = rawDelta.clone().transformDirection(invMat);

    const selVI = this._selectedVertIndices();

    // Build world positions of selected verts once for prop-edit distance calc
    const selWP = [];
    selVI.forEach(i => selWP.push(getWorldVert(pos, i, mat)));

    for (let i = 0; i < pos.count; i++) {
      let w;
      if (selVI.has(i)) {
        w = 1.0;
      } else {
        // Proportional editing: find closest selected vert in world space
        const wp = getWorldVert(pos, i, mat);
        let minD = Infinity;
        for (const sp of selWP) { const d = wp.distanceTo(sp); if (d < minD) minD = d; }
        w = smoothWeight(minD, PROP_RADIUS);
        if (w < 0.001) continue;
      }
      pos.setX(i, pos.getX(i) + localDelta.x * w);
      pos.setY(i, pos.getY(i) + localDelta.y * w);
      pos.setZ(i, pos.getZ(i) + localDelta.z * w);
    }

    pos.needsUpdate = true;
    this.targetMesh.geometry.computeVertexNormals();
    // Rebuild overlays but don't touch gizmo (avoid feedback loop)
    this._refreshGeomOnly();
  }

  // ── Overlay building ──────────────────────────────────────────────────────────
  _refresh() {
    this._refreshGeomOnly();
  }

  _refreshGeomOnly() {
    this._clear();
    if (!this.targetMesh) return;

    const geo   = this.targetMesh.geometry;
    const pos   = geo.attributes.position;
    const mat   = this.targetMesh.matrixWorld;
    const index = geo.index;
    const mode  = this.subMode;

    // ── Build edge map ──────────────────────────────────────────────────────
    // edgeMap: key → {a, b, faceCount, faces}
    const edgeMap = new Map();
    const addEdge = (a, b, fi) => {
      const k = edgeKey(a, b);
      if (!edgeMap.has(k)) edgeMap.set(k, { a, b, faceCount: 0, faces: [] });
      const e = edgeMap.get(k);
      e.faceCount++;
      e.faces.push(fi);
    };

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const fi = i / 3 | 0;
        const a = index.getX(i), b = index.getX(i+1), c = index.getX(i+2);
        addEdge(a, b, fi); addEdge(b, c, fi); addEdge(c, a, fi);
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        const fi = i / 3 | 0;
        addEdge(i, i+1, fi); addEdge(i+1, i+2, fi); addEdge(i+2, i, fi);
      }
    }

    // Detect and skip quad diagonals (the shared edge of two coplanar tris)
    const isQuadDiag = ({ faceCount, faces, a, b }) => {
      if (faceCount !== 2 || !index) return false;
      const tv = fi => [index.getX(fi*3), index.getX(fi*3+1), index.getX(fi*3+2)];
      const t0 = tv(faces[0]), t1 = tv(faces[1]);
      const all = [...new Set([...t0, ...t1])];
      if (all.length !== 4) return false;
      const vp = i => new THREE.Vector3().fromBufferAttribute(pos, i);
      const va = vp(t0[0]), n = new THREE.Vector3()
        .crossVectors(vp(t0[1]).sub(va), vp(t0[2]).sub(va)).normalize();
      const vd = vp(all.find(v => !t0.includes(v)));
      return Math.abs(n.dot(vd.clone().sub(va))) < 0.002;
    };

    // ── Vertex overlays ────────────────────────────────────────────────────
    this._vertMeshes = [];
    if (mode === 'vertex') {
      const baseGeo = new THREE.SphereGeometry(VERT_RADIUS, 7, 5);
      for (let i = 0; i < pos.count; i++) {
        const sel  = this.selVerts.has(i);
        const mesh = new THREE.Mesh(baseGeo, new THREE.MeshBasicMaterial({
          color:       sel ? COLOR.VERT_SEL : COLOR.VERT_IDLE,
          depthTest:   false,
          transparent: true,
          opacity:     sel ? 1.0 : 0.55,
        }));
        mesh.position.copy(getWorldVert(pos, i, mat));
        mesh.renderOrder        = 999;
        mesh.userData.vertIndex = i;
        this._grpVert.add(mesh);
        this._vertMeshes.push(mesh);
      }
    }

    // ── Edge overlays ──────────────────────────────────────────────────────
    this._edgeEntries = [];
    const positions = [], colors = [];

    const showEdges = (mode === 'edge' || mode === 'vertex' || mode === 'face');
    if (showEdges) {
      edgeMap.forEach((e, key) => {
        if (isQuadDiag(e)) return;
        const wa = getWorldVert(pos, e.a, mat);
        const wb = getWorldVert(pos, e.b, mat);
        positions.push(wa.x, wa.y, wa.z, wb.x, wb.y, wb.z);
        const sel = (mode === 'edge') && this.selEdges.has(key);
        const c   = new THREE.Color(sel ? COLOR.EDGE_SEL : COLOR.EDGE_IDLE);
        colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
        this._edgeEntries.push({ key, a: e.a, b: e.b,
          segStart: (this._edgeEntries.length) * 2 });
      });
    }

    if (positions.length) {
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      eg.setAttribute('color',    new THREE.Float32BufferAttribute(colors,    3));
      this._edgeLineSet = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({
        vertexColors: true, depthTest: false, transparent: true,
        opacity: mode === 'face' ? 0.45 : 0.85,
      }));
      this._edgeLineSet.renderOrder = 998;
      this._grpEdge.add(this._edgeLineSet);
    }

    // ── Face overlays ──────────────────────────────────────────────────────
    this._faceMeshes = [];
    if (mode === 'face' && index) {
      const faceCount = index.count / 3 | 0;
      for (let fi = 0; fi < faceCount; fi++) {
        const ai = index.getX(fi*3), bi = index.getX(fi*3+1), ci = index.getX(fi*3+2);
        const va = getWorldVert(pos, ai, mat);
        const vb = getWorldVert(pos, bi, mat);
        const vc = getWorldVert(pos, ci, mat);
        const fg = new THREE.BufferGeometry();
        fg.setAttribute('position', new THREE.Float32BufferAttribute(
          [va.x,va.y,va.z, vb.x,vb.y,vb.z, vc.x,vc.y,vc.z], 3));
        fg.setIndex([0, 1, 2]);
        const sel = this.selFaces.has(fi);
        const fm  = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
          color:       COLOR.FACE_SEL_COLOR,
          transparent: true,
          opacity:     sel ? COLOR.FACE_SEL_OP : COLOR.FACE_IDLE_OP,
          side:        THREE.DoubleSide,
          depthTest:   false,
        }));
        fm.renderOrder        = 997;
        fm.userData.faceIndex = fi;
        this._grpFace.add(fm);
        this._faceMeshes.push(fm);
      }
    }
  }

  _clear() {
    [this._grpVert, this._grpEdge, this._grpFace].forEach(g => {
      while (g.children.length) g.remove(g.children[0]);
    });
    this._vertMeshes  = [];
    this._edgeEntries = [];
    this._faceMeshes  = [];
    this._edgeLineSet = null;
  }

  // ── Picking ───────────────────────────────────────────────────────────────────
  _ndc(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - r.left)  / r.width)  * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
  }

  _pickVert(e) {
    this._rc.setFromCamera(this._ndc(e.clientX, e.clientY), this.camera);
    const hits = this._rc.intersectObjects(this._vertMeshes);
    return hits.length ? hits[0].object.userData.vertIndex : -1;
  }

  _pickEdge(e) {
    if (!this._edgeLineSet || !this._edgeEntries.length) return -1;
    this._rc.setFromCamera(this._ndc(e.clientX, e.clientY), this.camera);
    const ray      = this._rc.ray;
    const posAttr  = this._edgeLineSet.geometry.attributes.position;
    const THRESH2  = PICK_THRESH * PICK_THRESH;
    let bestDist   = THRESH2, bestIdx = -1;

    for (let i = 0; i < this._edgeEntries.length; i++) {
      const va = new THREE.Vector3().fromBufferAttribute(posAttr, i * 2);
      const vb = new THREE.Vector3().fromBufferAttribute(posAttr, i * 2 + 1);
      const d  = ray.distanceSqToSegment(va, vb);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
  }

  _pickFace(e) {
    this._rc.setFromCamera(this._ndc(e.clientX, e.clientY), this.camera);
    const hits = this._rc.intersectObjects(this._faceMeshes);
    return hits.length ? hits[0].object.userData.faceIndex : -1;
  }

  // ── Input handling ────────────────────────────────────────────────────────────
  _onPointerDown(e) {
    if (e.button !== 0) return;
    // If gizmo is being grabbed, let it handle
    if (this._gizmo.axis !== null) return;

    // B-key box select starts on pointer down only if _box.pending set by keydown
    if (this._box.pending) {
      this._startBoxSelect(e);
      return;
    }

    // Normal click-select
    this._doClickSelect(e);
  }

  _onPointerMove(e) {
    if (this._box.active) this._updateBoxSelect(e);
  }

  _onPointerUp(e) {
    if (this._box.active) { this._endBoxSelect(e); return; }
  }

  _doClickSelect(e) {
    const shift = e.shiftKey;

    if (this.subMode === 'vertex') {
      const vi = this._pickVert(e);
      if (vi >= 0) {
        if (shift) {
          this.selVerts.has(vi) ? this.selVerts.delete(vi) : this.selVerts.add(vi);
        } else {
          this.selVerts.clear(); this.selVerts.add(vi);
        }
      } else if (!shift) {
        this.selVerts.clear();
      }

    } else if (this.subMode === 'edge') {
      const ei = this._pickEdge(e);
      if (ei >= 0) {
        const key = this._edgeEntries[ei].key;
        if (shift) {
          this.selEdges.has(key) ? this.selEdges.delete(key) : this.selEdges.add(key);
        } else {
          this.selEdges.clear(); this.selEdges.add(key);
        }
      } else if (!shift) {
        this.selEdges.clear();
      }

    } else if (this.subMode === 'face') {
      const fi = this._pickFace(e);
      if (fi >= 0) {
        if (shift) {
          this.selFaces.has(fi) ? this.selFaces.delete(fi) : this.selFaces.add(fi);
        } else {
          this.selFaces.clear(); this.selFaces.add(fi);
        }
      } else if (!shift) {
        this.selFaces.clear();
      }
    }

    this._refresh();
    this._updateGizmo();
  }

  // ── Box select (B key → drag) ─────────────────────────────────────────────────
  _startBoxSelect(e) {
    this._box.pending = false;
    this._box.active  = true;
    this._box.start   = { x: e.clientX, y: e.clientY };

    const div = document.createElement('div');
    div.style.cssText = `position:fixed;border:1px solid #ff8800;background:rgba(255,136,0,0.08);
      pointer-events:none;z-index:9999;`;
    document.body.appendChild(div);
    this._box.div = div;

    this._updateBoxSelect(e);
  }

  _updateBoxSelect(e) {
    if (!this._box.div) return;
    const s = this._box.start;
    const x = Math.min(s.x, e.clientX), y = Math.min(s.y, e.clientY);
    const w = Math.abs(e.clientX - s.x), h = Math.abs(e.clientY - s.y);
    Object.assign(this._box.div.style, {
      left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px',
    });
    this._box.end = { x: e.clientX, y: e.clientY };
  }

  _endBoxSelect(e) {
    if (!this._box.active) return;
    this._box.active = false;
    if (this._box.div) { this._box.div.remove(); this._box.div = null; }
    if (!this._box.start || !this._box.end) return;

    const additive = e?.shiftKey;

    const r    = this.renderer.domElement.getBoundingClientRect();
    const s    = this._box.start, en = this._box.end ?? s;
    const minX = Math.min(s.x, en.x), maxX = Math.max(s.x, en.x);
    const minY = Math.min(s.y, en.y), maxY = Math.max(s.y, en.y);

    // NDC rect
    const ndcMin = new THREE.Vector2(
      ((minX - r.left) / r.width)  * 2 - 1,
      -((maxY - r.top) / r.height) * 2 + 1,
    );
    const ndcMax = new THREE.Vector2(
      ((maxX - r.left) / r.width)  * 2 - 1,
      -((minY - r.top) / r.height) * 2 + 1,
    );

    const inBox = (ndc) => ndc.x >= ndcMin.x && ndc.x <= ndcMax.x
                        && ndc.y >= ndcMin.y && ndc.y <= ndcMax.y;

    const proj     = new THREE.Vector3();
    const projMat  = new THREE.Matrix4().multiplyMatrices(
      this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const pos      = this.targetMesh.geometry.attributes.position;
    const mat      = this.targetMesh.matrixWorld;
    const index    = this.targetMesh.geometry.index;

    const ndcOfVert = (i) => {
      proj.fromBufferAttribute(pos, i).applyMatrix4(mat).applyMatrix4(projMat);
      return new THREE.Vector2(proj.x, proj.y);
    };

    if (!additive) {
      this.selVerts.clear(); this.selEdges.clear(); this.selFaces.clear();
    }

    if (this.subMode === 'vertex') {
      for (let i = 0; i < pos.count; i++) {
        if (inBox(ndcOfVert(i))) this.selVerts.add(i);
      }
    } else if (this.subMode === 'edge') {
      this._edgeEntries.forEach(({ key, a, b }) => {
        if (inBox(ndcOfVert(a)) && inBox(ndcOfVert(b))) this.selEdges.add(key);
      });
    } else if (this.subMode === 'face' && index) {
      const faceCount = index.count / 3 | 0;
      for (let fi = 0; fi < faceCount; fi++) {
        const ai = index.getX(fi*3), bi = index.getX(fi*3+1), ci = index.getX(fi*3+2);
        if (inBox(ndcOfVert(ai)) && inBox(ndcOfVert(bi)) && inBox(ndcOfVert(ci)))
          this.selFaces.add(fi);
      }
    }

    this._refresh();
    this._updateGizmo();
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────────
  _onKeyDown(e) {
    // Sub-mode shortcuts: 1/2/3  (Blender-style, no numpad dependency)
    if (!e.ctrlKey && !e.altKey) {
      if (e.key === '1') { this.setSubMode('vertex'); this._syncModeButtons('vertex'); return; }
      if (e.key === '2') { this.setSubMode('edge');   this._syncModeButtons('edge');   return; }
      if (e.key === '3') { this.setSubMode('face');   this._syncModeButtons('face');   return; }

      // A — select all / deselect all (toggle)
      if (e.key === 'a' || e.key === 'A') {
        this._toggleSelectAll(); return;
      }

      // B — start box-select on next pointer-down
      if ((e.key === 'b' || e.key === 'B') && !this._box.active) {
        this._box.pending = true; return;
      }

      // G — grab: if something is selected and gizmo is attached, fake-start drag
      // (just a UX hint; actual drag is via gizmo click)
    }

    // Ctrl+Z — undo
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
      e.stopImmediatePropagation();
      this.undo();
      return;
    }

    // Escape — clear box-select pending / deselect
    if (e.key === 'Escape') {
      if (this._box.pending) { this._box.pending = false; return; }
      this.selVerts.clear(); this.selEdges.clear(); this.selFaces.clear();
      this._refresh(); this._hideGizmo();
    }
  }

  _toggleSelectAll() {
    const pos   = this.targetMesh?.geometry?.attributes?.position;
    const index = this.targetMesh?.geometry?.index;
    if (!pos) return;

    if (this.subMode === 'vertex') {
      if (this.selVerts.size === pos.count) { this.selVerts.clear(); }
      else { for (let i = 0; i < pos.count; i++) this.selVerts.add(i); }
    } else if (this.subMode === 'edge') {
      const total = this._edgeEntries.length;
      if (this.selEdges.size === total) { this.selEdges.clear(); }
      else { this._edgeEntries.forEach(e => this.selEdges.add(e.key)); }
    } else if (this.subMode === 'face' && index) {
      const total = index.count / 3 | 0;
      if (this.selFaces.size === total) { this.selFaces.clear(); }
      else { for (let i = 0; i < total; i++) this.selFaces.add(i); }
    }
    this._refresh(); this._updateGizmo();
  }

  _syncModeButtons(mode) {
    const map = { vertex: 'msub-vert', edge: 'msub-edge', face: 'msub-face' };
    document.querySelectorAll('#mesh-toolbar .tool-btn')
      .forEach(b => b.classList.remove('active'));
    document.getElementById(map[mode])?.classList.add('active');
  }
}

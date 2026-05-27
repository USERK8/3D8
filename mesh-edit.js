import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const COLOR = {
  VERT_IDLE     : 0x222222,
  VERT_SEL      : 0xff8800,
  EDGE_IDLE     : 0x333333,
  EDGE_SEL      : 0xff8800,
  FACE_SEL_COLOR: 0xff8800,
  FACE_SEL_OP   : 0.30,
};

const VERT_RADIUS  = 0.055;
const GIZMO_SIZE   = 0.75;
const EDGE_PICK_PX = 14;

function edgeKey(a, b) { return a < b ? `${a}_${b}` : `${b}_${a}`; }

function getWorldVert(posAttr, i, matWorld) {
  return new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(matWorld);
}

function worldToScreen(worldPos, camera) {
  const v = worldPos.clone().project(camera);
  return new THREE.Vector2(
    ( v.x + 1) / 2 * window.innerWidth,
    (-v.y + 1) / 2 * window.innerHeight
  );
}

function screenDistToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx*dx + dy*dy;
  if (lenSq === 0) return Math.hypot(px-ax, py-ay);
  const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / lenSq));
  return Math.hypot(px - (ax + t*dx), py - (ay + t*dy));
}

export class MeshEditor {
  constructor(scene, camera, renderer, orbitControls) {
    this.scene    = scene;
    this.camera   = camera;
    this.renderer = renderer;
    this.orbit    = orbitControls;

    this.targetMesh = null;
    this.subMode    = 'vertex';

    this.selVerts = new Set();
    this.selEdges = new Set();
    this.selFaces = new Set();

    this._undoStack = [];
    this._preSnap   = null;
    this._dragBase  = new THREE.Vector3();

    this._vertMeshes    = [];
    this._edgeEntries   = [];
    this._faceMeshes    = [];
    this._faceHitMeshes = [];
    this._edgeLineSet   = null;

    this._grpVert = new THREE.Group();
    this._grpEdge = new THREE.Group();
    this._grpFace = new THREE.Group();
    scene.add(this._grpVert, this._grpEdge, this._grpFace);

    this._rc = new THREE.Raycaster();

    this._proxy = new THREE.Object3D();
    scene.add(this._proxy);

    this._gizmo = new TransformControls(camera, renderer.domElement);
    this._gizmo.setMode('translate');
    this._gizmo.setSize(GIZMO_SIZE);
    this._gizmo.translationSnap = null;  // free movement, no grid snap (Blender-style)
    this._gizmo.rotationSnap    = null;
    this._gizmo.scaleSnap       = null;
    scene.add(this._gizmo);

    this._isDragging = false;

    this._gizmo.addEventListener('mouseDown', () => {
      this.orbit.enabled = false;
      this._isDragging = true;
      this._saveSnap();
      this._dragBase.copy(this._proxy.position);
    });

    this._gizmo.addEventListener('change', () => {
      if (!this._isDragging) return;
      this._applyTotalDelta();
    });

    this._gizmo.addEventListener('mouseUp', () => {
      this.orbit.enabled = true;
      this._isDragging = false;
      this._commitSnap();
      // Re-anchor to new centroid after drag — reposition proxy without resetting it mid-drag
      const c = this._centroid();
      if (c) {
        this._proxy.position.copy(c);
        this._dragBase.copy(c);
        this._gizmo.attach(this._proxy);
      } else {
        this._hideGizmo();
      }
    });

    this._box = { active: false, pending: false, start: null, end: null, div: null };

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp   = this._onPointerUp.bind(this);
    this._onKeyDown     = this._onKeyDown.bind(this);
  }

  enter(mesh) {
    this.targetMesh = mesh;
    this.subMode    = 'vertex';
    this.selVerts.clear(); this.selEdges.clear(); this.selFaces.clear();
    this._undoStack = [];

    // Fix backface culling and transparency on the mesh itself
    this._origSide       = mesh.material.side;
    this._origDepthWrite = mesh.material.depthWrite;
    mesh.material.side       = THREE.DoubleSide;
    mesh.material.depthWrite = true;
    mesh.material.needsUpdate = true;

    this._rebuild();
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
    if (this.targetMesh) {
      this.targetMesh.material.side        = this._origSide       ?? THREE.FrontSide;
      this.targetMesh.material.depthWrite   = this._origDepthWrite ?? true;
      this.targetMesh.material.needsUpdate  = true;
    }
    this.targetMesh = null;
    this.selVerts.clear(); this.selEdges.clear(); this.selFaces.clear();
    this._endBoxSelect();

    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerup',   this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
  }

  setSubMode(mode) {
    this.subMode = mode;
    if (mode !== 'vertex') this.selVerts.clear();
    if (mode !== 'edge')   this.selEdges.clear();
    if (mode !== 'face')   this.selFaces.clear();
    this._rebuild();
    this._updateGizmo();
  }

  setGizmoMode(mode) { this._gizmo.setMode(mode); }

  undo() {
    if (!this._undoStack.length) return false;
    const snap = this._undoStack.pop();
    const pos  = this.targetMesh.geometry.attributes.position;
    snap.forEach((v, i) => pos.setXYZ(i, v.x, v.y, v.z));
    pos.needsUpdate = true;
    this.targetMesh.geometry.computeVertexNormals();
    this._rebuild();
    this._updateGizmo();
    return true;
  }

  _saveSnap() {
    const pos = this.targetMesh.geometry.attributes.position;
    this._preSnap = Array.from({ length: pos.count },
      (_, i) => new THREE.Vector3().fromBufferAttribute(pos, i));
  }
  _commitSnap() {
    if (this._preSnap) { this._undoStack.push(this._preSnap); this._preSnap = null; }
  }

  _showGizmo(worldPos) {
    this._proxy.position.copy(worldPos);
    this._dragBase.copy(worldPos);
    this._gizmo.attach(this._proxy);
  }
  _hideGizmo() { this._gizmo.detach(); }
  _reanchorGizmo() {
    const c = this._centroid();
    c ? this._showGizmo(c) : this._hideGizmo();
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
    const index = this.targetMesh?.geometry?.index;
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

  _applyTotalDelta() {
    if (!this._preSnap) return;
    const totalWorld = this._proxy.position.clone().sub(this._dragBase);
    if (totalWorld.lengthSq() < 1e-18) return;
    const pos        = this.targetMesh.geometry.attributes.position;
    const invMat     = this.targetMesh.matrixWorld.clone().invert();
    const totalLocal = totalWorld.clone().transformDirection(invMat);
    const vis        = this._selectedVertIndices();
    vis.forEach(i => {
      pos.setXYZ(i,
        this._preSnap[i].x + totalLocal.x,
        this._preSnap[i].y + totalLocal.y,
        this._preSnap[i].z + totalLocal.z,
      );
    });
    pos.needsUpdate = true;
    this.targetMesh.geometry.computeVertexNormals();
    this._rebuildOverlaysOnly();
  }

  _rebuild() {
    this._buildEdgeMap();
    this._rebuildOverlaysOnly();
  }

  _buildEdgeMap() {
    if (!this.targetMesh) return;
    const geo   = this.targetMesh.geometry;
    const pos   = geo.attributes.position;
    const index = geo.index;

    this._edgeMap = new Map();
    const addEdge = (a, b, fi) => {
      const k = edgeKey(a, b);
      if (!this._edgeMap.has(k)) this._edgeMap.set(k, { a, b, faceCount:0, faces:[] });
      const e = this._edgeMap.get(k); e.faceCount++; e.faces.push(fi);
    };

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const fi = i/3|0, a = index.getX(i), b = index.getX(i+1), c = index.getX(i+2);
        addEdge(a,b,fi); addEdge(b,c,fi); addEdge(c,a,fi);
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        const fi = i/3|0;
        addEdge(i,i+1,fi); addEdge(i+1,i+2,fi); addEdge(i+2,i,fi);
      }
    }

    this._isQuadDiag = (e) => {
      if (e.faceCount !== 2 || !index) return false;
      const tv = fi => [index.getX(fi*3), index.getX(fi*3+1), index.getX(fi*3+2)];
      const t0 = tv(e.faces[0]), t1 = tv(e.faces[1]);
      const all = [...new Set([...t0,...t1])];
      if (all.length !== 4) return false;
      const vp = i => new THREE.Vector3().fromBufferAttribute(pos, i);
      const va = vp(t0[0]);
      const n  = new THREE.Vector3()
        .crossVectors(vp(t0[1]).clone().sub(va), vp(t0[2]).clone().sub(va)).normalize();
      const vd = vp(all.find(v => !t0.includes(v)));
      return Math.abs(n.dot(vd.clone().sub(va))) < 0.002;
    };
  }

  _rebuildOverlaysOnly() {
    this._clear();
    if (!this.targetMesh || !this._edgeMap) return;

    const geo   = this.targetMesh.geometry;
    const pos   = geo.attributes.position;
    const mat   = this.targetMesh.matrixWorld;
    const index = geo.index;
    const mode  = this.subMode;

    // Vertices
    this._vertMeshes = [];
    if (mode === 'vertex') {
      const baseGeo = new THREE.SphereGeometry(VERT_RADIUS, 7, 5);
      for (let i = 0; i < pos.count; i++) {
        const sel  = this.selVerts.has(i);
        const mesh = new THREE.Mesh(baseGeo, new THREE.MeshBasicMaterial({
          color: sel ? COLOR.VERT_SEL : COLOR.VERT_IDLE,
          depthTest: true,
          side: THREE.DoubleSide,
        }));
        mesh.position.copy(getWorldVert(pos, i, mat));
        mesh.renderOrder        = 999;
        mesh.userData.vertIndex = i;
        this._grpVert.add(mesh);
        this._vertMeshes.push(mesh);
      }
    }

    // Edges
    this._edgeEntries = [];
    const positions = [], colors = [];

    this._edgeMap.forEach((e, key) => {
      if (this._isQuadDiag(e)) return;
      const wa = getWorldVert(pos, e.a, mat);
      const wb = getWorldVert(pos, e.b, mat);
      positions.push(wa.x,wa.y,wa.z, wb.x,wb.y,wb.z);
      const sel = (mode === 'edge') && this.selEdges.has(key);
      const c   = new THREE.Color(sel ? COLOR.EDGE_SEL : COLOR.EDGE_IDLE);
      colors.push(c.r,c.g,c.b, c.r,c.g,c.b);
      this._edgeEntries.push({ key, a: e.a, b: e.b });
    });

    if (positions.length) {
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      eg.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
      this._edgeLineSet = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({
        vertexColors: true, depthTest: true, transparent: false, opacity: 1.0,
      }));
      this._edgeLineSet.renderOrder = 1;
      this._grpEdge.add(this._edgeLineSet);
    }

    // Selected edges as cylinders (thick highlight)
    if (mode === 'edge') {
      this.selEdges.forEach(key => {
        const entry = this._edgeEntries.find(e => e.key === key);
        if (!entry) return;
        const wa = getWorldVert(pos, entry.a, mat);
        const wb = getWorldVert(pos, entry.b, mat);
        const dir    = wb.clone().sub(wa);
        const length = dir.length();
        if (length < 1e-6) return;
        const mid = wa.clone().add(wb).multiplyScalar(0.5);
        const cyl = new THREE.Mesh(
          new THREE.CylinderGeometry(0.012, 0.012, length, 6),
          new THREE.MeshBasicMaterial({ color: COLOR.EDGE_SEL, depthTest: true })
        );
        cyl.position.copy(mid);
        cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir.clone().normalize());
        cyl.renderOrder = 2;
        this._grpEdge.add(cyl);
      });
    }

    // Faces
    this._faceMeshes    = [];
    this._faceHitMeshes = [];

    if (mode === 'face' && index) {
      const faceCount = index.count/3|0;
      for (let fi = 0; fi < faceCount; fi++) {
        const ai = index.getX(fi*3), bi = index.getX(fi*3+1), ci = index.getX(fi*3+2);
        const va = getWorldVert(pos, ai, mat);
        const vb = getWorldVert(pos, bi, mat);
        const vc = getWorldVert(pos, ci, mat);
        const verts = [va.x,va.y,va.z, vb.x,vb.y,vb.z, vc.x,vc.y,vc.z];

        const sel = this.selFaces.has(fi);
        const fg  = new THREE.BufferGeometry();
        fg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        fg.setIndex([0,1,2]);
        const fm = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
          color: COLOR.FACE_SEL_COLOR, transparent: true,
          opacity: sel ? COLOR.FACE_SEL_OP : 0.0,
          side: THREE.DoubleSide, depthTest: true,
        }));
        fm.renderOrder        = 2;
        fm.userData.faceIndex = fi;
        this._grpFace.add(fm);
        this._faceMeshes.push(fm);

        const hg = new THREE.BufferGeometry();
        hg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        hg.setIndex([0,1,2]);
        const hm = new THREE.Mesh(hg, new THREE.MeshBasicMaterial({
          transparent: true, opacity: 0, side: THREE.DoubleSide, depthTest: true,
        }));
        hm.renderOrder        = 1;
        hm.userData.faceIndex = fi;
        this._grpFace.add(hm);
        this._faceHitMeshes.push(hm);
      }
    }
  }

  _clear() {
    [this._grpVert, this._grpEdge, this._grpFace].forEach(g => {
      while (g.children.length) g.remove(g.children[0]);
    });
    this._vertMeshes    = [];
    this._edgeEntries   = [];
    this._faceMeshes    = [];
    this._faceHitMeshes = [];
    this._edgeLineSet   = null;
  }

  _ndc(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - r.left) / r.width)  * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
  }

  _pickVert(e) {
    this._rc.setFromCamera(this._ndc(e.clientX, e.clientY), this.camera);
    const hits = this._rc.intersectObjects(this._vertMeshes);
    return hits.length ? hits[0].object.userData.vertIndex : -1;
  }

  _pickEdge(clientX, clientY) {
    if (!this._edgeLineSet || !this._edgeEntries.length) return -1;
    const posAttr = this._edgeLineSet.geometry.attributes.position;
    let bestDist  = EDGE_PICK_PX, bestIdx = -1;
    for (let i = 0; i < this._edgeEntries.length; i++) {
      const wa = new THREE.Vector3().fromBufferAttribute(posAttr, i*2);
      const wb = new THREE.Vector3().fromBufferAttribute(posAttr, i*2+1);
      const sa = worldToScreen(wa, this.camera);
      const sb = worldToScreen(wb, this.camera);
      const d  = screenDistToSeg(clientX, clientY, sa.x, sa.y, sb.x, sb.y);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
  }

  _pickFace(e) {
    this._rc.setFromCamera(this._ndc(e.clientX, e.clientY), this.camera);
    const hits = this._rc.intersectObjects(this._faceHitMeshes);
    return hits.length ? hits[0].object.userData.faceIndex : -1;
  }

  _onPointerDown(e) {
    if (e.button !== 0) return;
    if (this._gizmo.axis !== null) return;
    if (this._box.pending) { this._startBoxSelect(e); return; }
    this._doClickSelect(e);
  }

  _onPointerMove(e) {
    if (this._box.active) this._updateBoxSelect(e);
  }

  _onPointerUp(e) {
    if (this._box.active) this._endBoxSelect(e);
  }

  _doClickSelect(e) {
    const shift = e.shiftKey;

    if (this.subMode === 'vertex') {
      const vi = this._pickVert(e);
      if (vi >= 0) {
        shift
          ? (this.selVerts.has(vi) ? this.selVerts.delete(vi) : this.selVerts.add(vi))
          : (this.selVerts.clear(), this.selVerts.add(vi));
      } else if (!shift) {
        this.selVerts.clear();
      }
    } else if (this.subMode === 'edge') {
      const ei = this._pickEdge(e.clientX, e.clientY);
      if (ei >= 0) {
        const key = this._edgeEntries[ei].key;
        shift
          ? (this.selEdges.has(key) ? this.selEdges.delete(key) : this.selEdges.add(key))
          : (this.selEdges.clear(), this.selEdges.add(key));
      } else if (!shift) {
        this.selEdges.clear();
      }
    } else if (this.subMode === 'face') {
      const fi = this._pickFace(e);
      if (fi >= 0) {
        shift
          ? (this.selFaces.has(fi) ? this.selFaces.delete(fi) : this.selFaces.add(fi))
          : (this.selFaces.clear(), this.selFaces.add(fi));
      } else if (!shift) {
        this.selFaces.clear();
      }
    }

    this._rebuild();
    this._updateGizmo();
  }

  _startBoxSelect(e) {
    this._box.pending = false;
    this._box.active  = true;
    this._box.start   = { x: e.clientX, y: e.clientY };
    this._box.end     = { x: e.clientX, y: e.clientY };
    const div = document.createElement('div');
    div.style.cssText = `position:fixed;border:1px solid #ff8800;
      background:rgba(255,136,0,0.08);pointer-events:none;z-index:9999;`;
    document.body.appendChild(div);
    this._box.div = div;
    this._updateBoxSelect(e);
  }

  _updateBoxSelect(e) {
    if (!this._box.div) return;
    this._box.end = { x: e.clientX, y: e.clientY };
    const s = this._box.start, en = this._box.end;
    Object.assign(this._box.div.style, {
      left: Math.min(s.x,en.x)+'px', top:    Math.min(s.y,en.y)+'px',
      width: Math.abs(en.x-s.x)+'px', height: Math.abs(en.y-s.y)+'px',
    });
  }

  _endBoxSelect(e) {
    if (!this._box.active) return;
    this._box.active = false;
    if (this._box.div) { this._box.div.remove(); this._box.div = null; }

    const s = this._box.start, en = this._box.end ?? s;
    const additive = e?.shiftKey;
    const minX = Math.min(s.x,en.x), maxX = Math.max(s.x,en.x);
    const minY = Math.min(s.y,en.y), maxY = Math.max(s.y,en.y);

    const r     = this.renderer.domElement.getBoundingClientRect();
    const projM = new THREE.Matrix4().multiplyMatrices(
      this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const pos   = this.targetMesh.geometry.attributes.position;
    const mat   = this.targetMesh.matrixWorld;
    const index = this.targetMesh.geometry.index;

    const vertScreen = (i) => {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mat).applyMatrix4(projM);
      return { x: (v.x+1)/2*r.width+r.left, y: (-v.y+1)/2*r.height+r.top };
    };
    const inBox = (i) => {
      const s = vertScreen(i);
      return s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;
    };

    if (!additive) { this.selVerts.clear(); this.selEdges.clear(); this.selFaces.clear(); }

    if (this.subMode === 'vertex') {
      for (let i = 0; i < pos.count; i++) if (inBox(i)) this.selVerts.add(i);
    } else if (this.subMode === 'edge') {
      this._edgeEntries.forEach(({ key, a, b }) => {
        if (inBox(a) && inBox(b)) this.selEdges.add(key);
      });
    } else if (this.subMode === 'face' && index) {
      const fc = index.count/3|0;
      for (let fi = 0; fi < fc; fi++) {
        const ai = index.getX(fi*3), bi = index.getX(fi*3+1), ci = index.getX(fi*3+2);
        if (inBox(ai) && inBox(bi) && inBox(ci)) this.selFaces.add(fi);
      }
    }

    this._rebuild();
    this._updateGizmo();
  }

  _onKeyDown(e) {
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
      e.stopImmediatePropagation();
      this.undo();
      return;
    }
    if (e.ctrlKey || e.altKey) return;

    if (e.key === '1') { this.setSubMode('vertex'); this._syncModeButtons('vertex'); return; }
    if (e.key === '2') { this.setSubMode('edge');   this._syncModeButtons('edge');   return; }
    if (e.key === '3') { this.setSubMode('face');   this._syncModeButtons('face');   return; }
    if (e.key === 'a' || e.key === 'A') { this._toggleSelectAll(); return; }
    if ((e.key === 'b' || e.key === 'B') && !this._box.active) { this._box.pending = true; return; }

    if (e.key === 'Escape') {
      if (this._box.pending) { this._box.pending = false; return; }
      this.selVerts.clear(); this.selEdges.clear(); this.selFaces.clear();
      this._rebuild(); this._hideGizmo();
    }
  }

  _toggleSelectAll() {
    const pos   = this.targetMesh?.geometry?.attributes?.position;
    const index = this.targetMesh?.geometry?.index;
    if (!pos) return;
    if (this.subMode === 'vertex') {
      if (this.selVerts.size === pos.count) this.selVerts.clear();
      else for (let i = 0; i < pos.count; i++) this.selVerts.add(i);
    } else if (this.subMode === 'edge') {
      if (this.selEdges.size === this._edgeEntries.length) this.selEdges.clear();
      else this._edgeEntries.forEach(e => this.selEdges.add(e.key));
    } else if (this.subMode === 'face' && index) {
      const total = index.count/3|0;
      if (this.selFaces.size === total) this.selFaces.clear();
      else for (let i = 0; i < total; i++) this.selFaces.add(i);
    }
    this._rebuild(); this._updateGizmo();
  }

  _syncModeButtons(mode) {
    const map = { vertex:'msub-vert', edge:'msub-edge', face:'msub-face' };
    document.querySelectorAll('#mesh-toolbar .tool-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(map[mode])?.classList.add('active');
  }
}

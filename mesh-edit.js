import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// ── Colours ───────────────────────────────────────────────────────────────────
const VERT_IDLE        = 0xaaaaaa;
const VERT_SEL         = 0xcc88ff;   // glass-purple
const EDGE_IDLE        = 0x556677;
const EDGE_SEL         = 0xcc88ff;
const FACE_IDLE_OP     = 0.0;        // invisible when not selected
const FACE_SEL_COLOR   = 0xcc88ff;
const FACE_SEL_OP      = 0.38;
const VERT_RADIUS      = 0.032;

// How far (world units) the soft-falloff reaches beyond selected verts
const FALLOFF_RADIUS   = 1.2;
// Scale gizmo movement down so dragging isn't crazy fast
const DRAG_SCALE       = 0.35;

export class MeshEditor {
  constructor(scene, camera, renderer, orbitControls) {
    this.scene    = scene;
    this.camera   = camera;
    this.renderer = renderer;
    this.orbit    = orbitControls;
    this.targetMesh = null;

    this.vertGroup = new THREE.Group();
    this.edgeGroup = new THREE.Group();
    this.faceGroup = new THREE.Group();
    scene.add(this.vertGroup, this.edgeGroup, this.faceGroup);

    this.subMode = 'vertex';

    this.selectedVerts = new Set();
    this.selectedEdges = new Set();
    this.selectedFaces = new Set();

    this._undoStack   = [];
    this._pendingSnap = null;

    this._raycaster  = new THREE.Raycaster();
    this._vertMeshes = [];
    this._edgeKeys   = [];
    this._faceMeshes = [];
    this._edgeLines  = null;

    this._gizmoProxy   = new THREE.Object3D();
    this._prevGizmoPos = new THREE.Vector3();
    scene.add(this._gizmoProxy);

    this._gizmo = new TransformControls(camera, renderer.domElement);
    this._gizmo.setMode('translate');
    this._gizmo.setSize(0.7);
    scene.add(this._gizmo);

    this._gizmo.addEventListener('mouseDown', () => {
      this.orbit.enabled = false;
      this._snapPositions();
    });
    this._gizmo.addEventListener('mouseUp', () => {
      this.orbit.enabled = true;
      this._pushUndo();
    });
    this._gizmo.addEventListener('change', () => {
      if (!this._gizmo.dragging) return;
      this._applyGizmoDelta();
    });

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onKeyDown     = this._onKeyDown.bind(this);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  enter(mesh) {
    this.targetMesh = mesh;
    this.selectedVerts.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this._undoStack = [];
    this.subMode    = 'vertex';
    this._buildHelpers();
    this._hideGizmo();
    this.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('keydown', this._onKeyDown);
  }

  exit() {
    this._clearHelpers();
    this._hideGizmo();
    this.targetMesh = null;
    this.selectedVerts.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('keydown', this._onKeyDown);
  }

  setSubMode(mode) {
    this.subMode = mode;
    this.selectedVerts.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this._buildHelpers();
    this._hideGizmo();
  }

  undo() {
    if (!this._undoStack.length) return false;
    const snap = this._undoStack.pop();
    const pos  = this.targetMesh.geometry.attributes.position;
    for (let i = 0; i < snap.length; i++) pos.setXYZ(i, snap[i].x, snap[i].y, snap[i].z);
    pos.needsUpdate = true;
    this.targetMesh.geometry.computeVertexNormals();
    this._buildHelpers();
    this._updateGizmo();
    return true;
  }

  // ── Undo ───────────────────────────────────────────────────────────────────
  _snapPositions() {
    const pos = this.targetMesh.geometry.attributes.position;
    this._pendingSnap = Array.from({ length: pos.count }, (_, i) =>
      new THREE.Vector3().fromBufferAttribute(pos, i)
    );
  }
  _pushUndo() {
    if (this._pendingSnap) { this._undoStack.push(this._pendingSnap); this._pendingSnap = null; }
  }

  // ── Gizmo ──────────────────────────────────────────────────────────────────
  _showGizmo(worldPos) {
    this._gizmoProxy.position.copy(worldPos);
    this._prevGizmoPos.copy(worldPos);
    this._gizmo.attach(this._gizmoProxy);
  }
  _hideGizmo() { this._gizmo.detach(); }
  _updateGizmo() {
    const c = this._getSelectionCentroid();
    c ? this._showGizmo(c) : this._hideGizmo();
  }

  _getSelectionCentroid() {
    const pos = this.targetMesh?.geometry?.attributes?.position;
    const mat = this.targetMesh?.matrixWorld;
    if (!pos || !mat) return null;
    const verts = this._getSelectedVertIndices();
    if (!verts.size) return null;
    const c = new THREE.Vector3();
    verts.forEach(vi => c.add(new THREE.Vector3().fromBufferAttribute(pos, vi).applyMatrix4(mat)));
    return c.divideScalar(verts.size);
  }

  _getSelectedVertIndices() {
    const out   = new Set();
    const index = this.targetMesh?.geometry?.index;
    if (this.subMode === 'vertex') {
      this.selectedVerts.forEach(vi => out.add(vi));
    } else if (this.subMode === 'edge') {
      this.selectedEdges.forEach(key => {
        const [a, b] = key.split('_').map(Number);
        out.add(a); out.add(b);
      });
    } else if (this.subMode === 'face' && index) {
      this.selectedFaces.forEach(fi => {
        out.add(index.getX(fi * 3));
        out.add(index.getX(fi * 3 + 1));
        out.add(index.getX(fi * 3 + 2));
      });
    }
    return out;
  }

  // ── Movement with smooth falloff ───────────────────────────────────────────
  _applyGizmoDelta() {
    // Raw world-space delta from gizmo proxy
    const rawDelta = this._gizmoProxy.position.clone().sub(this._prevGizmoPos);
    if (rawDelta.lengthSq() < 1e-12) return;

    // Dampen speed
    const delta = rawDelta.multiplyScalar(DRAG_SCALE);

    // Snap proxy back — we apply our own scaled delta and reposition the gizmo ourselves
    this._gizmoProxy.position.copy(this._prevGizmoPos).add(delta);

    const invMat     = this.targetMesh.matrixWorld.clone().invert();
    const localDelta = delta.clone().transformDirection(invMat);
    const pos        = this.targetMesh.geometry.attributes.position;
    const mat        = this.targetMesh.matrixWorld;

    const selectedVI = this._getSelectedVertIndices();

    // Build world-space positions of selected verts for falloff computation
    const selWorldPos = [];
    selectedVI.forEach(vi => {
      selWorldPos.push(new THREE.Vector3().fromBufferAttribute(pos, vi).applyMatrix4(mat));
    });

    // For every vertex: compute weight
    //   selected  → weight 1.0
    //   unselected → smooth falloff based on distance to nearest selected vert
    for (let i = 0; i < pos.count; i++) {
      let weight;
      if (selectedVI.has(i)) {
        weight = 1.0;
      } else {
        const wv = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mat);
        let minDist = Infinity;
        for (const sv of selWorldPos) { const d = wv.distanceTo(sv); if (d < minDist) minDist = d; }
        if (minDist >= FALLOFF_RADIUS) continue; // no influence
        // Smooth-step falloff: 1 at dist=0, 0 at dist=FALLOFF_RADIUS
        const t = minDist / FALLOFF_RADIUS;
        weight = 1 - t * t * (3 - 2 * t); // smoothstep
        if (weight < 0.001) continue;
      }
      pos.setX(i, pos.getX(i) + localDelta.x * weight);
      pos.setY(i, pos.getY(i) + localDelta.y * weight);
      pos.setZ(i, pos.getZ(i) + localDelta.z * weight);
    }

    pos.needsUpdate = true;
    this.targetMesh.geometry.computeVertexNormals();
    this._buildHelpers();

    // Reposition gizmo to new centroid so it follows the selection
    this._prevGizmoPos.copy(this._gizmoProxy.position);
    const newCentroid = this._getSelectionCentroid();
    if (newCentroid) {
      this._gizmoProxy.position.copy(newCentroid);
      this._prevGizmoPos.copy(newCentroid);
    }
  }

  // ── Build helpers ──────────────────────────────────────────────────────────
  _buildHelpers() {
    this._clearHelpers();
    if (!this.targetMesh) return;

    const geo = this.targetMesh.geometry;
    const pos = geo.attributes.position;
    const mat = this.targetMesh.matrixWorld;
    const index = geo.index;

    // ── Vertices ──
    this._vertMeshes = [];
    const sphereGeo  = new THREE.SphereGeometry(VERT_RADIUS, 8, 6);
    for (let i = 0; i < pos.count; i++) {
      const wv  = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mat);
      const sel = this.selectedVerts.has(i);
      const m   = new THREE.Mesh(sphereGeo, new THREE.MeshBasicMaterial({
        color:       sel ? VERT_SEL : VERT_IDLE,
        depthTest:   false,
        transparent: true,
        opacity:     sel ? 0.92 : 0.55,
      }));
      m.position.copy(wv);
      m.renderOrder        = 999;
      m.userData.vertIndex = i;
      this.vertGroup.add(m);
      this._vertMeshes.push(m);
    }

    // ── Edges — deduplicated, no internal diagonals ──
    const edgeMap = new Map();
    const addE = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!edgeMap.has(key)) edgeMap.set(key, { count: 0, a, b });
      edgeMap.get(key).count++;
    };
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i), b = index.getX(i+1), c = index.getX(i+2);
        addE(a,b); addE(b,c); addE(c,a);
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) { addE(i,i+1); addE(i+1,i+2); addE(i+2,i); }
    }

    this._edgeKeys = [];
    const edgeVerts = [], edgeColors = [];
    edgeMap.forEach(({ count, a, b }, key) => {
      if (count > 2) return;
      const va = new THREE.Vector3().fromBufferAttribute(pos, a).applyMatrix4(mat);
      const vb = new THREE.Vector3().fromBufferAttribute(pos, b).applyMatrix4(mat);
      edgeVerts.push(va.x,va.y,va.z, vb.x,vb.y,vb.z);
      this._edgeKeys.push(key);
      const sel = this.selectedEdges.has(key);
      const c   = new THREE.Color(sel ? EDGE_SEL : EDGE_IDLE);
      edgeColors.push(c.r,c.g,c.b, c.r,c.g,c.b);
    });

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3));
    edgeGeo.setAttribute('color',    new THREE.Float32BufferAttribute(edgeColors, 3));
    this._edgeLines = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({
      vertexColors: true, depthTest: false, transparent: true, opacity: 0.75,
    }));
    this._edgeLines.renderOrder = 998;
    this.edgeGroup.add(this._edgeLines);

    // ── Faces ──
    this._faceMeshes = [];
    const fg2 = new THREE.Group();
    this.faceGroup.add(fg2);

    if (index) {
      // Thickness shell (back-side, slightly bigger)
      const shell = new THREE.Mesh(
        geo.clone().applyMatrix4(mat),
        new THREE.MeshBasicMaterial({ color: 0x1a0a2e, side: THREE.BackSide, transparent: true, opacity: 0.15 })
      );
      shell.scale.setScalar(1.012);
      shell.renderOrder = 996;
      fg2.add(shell);

      for (let i = 0; i < index.count / 3; i++) {
        const ai = index.getX(i*3), bi = index.getX(i*3+1), ci = index.getX(i*3+2);
        const va = new THREE.Vector3().fromBufferAttribute(pos, ai).applyMatrix4(mat);
        const vb = new THREE.Vector3().fromBufferAttribute(pos, bi).applyMatrix4(mat);
        const vc = new THREE.Vector3().fromBufferAttribute(pos, ci).applyMatrix4(mat);
        const tfg = new THREE.BufferGeometry();
        tfg.setAttribute('position', new THREE.Float32BufferAttribute([
          va.x,va.y,va.z, vb.x,vb.y,vb.z, vc.x,vc.y,vc.z,
        ], 3));
        tfg.setIndex([0,1,2]);
        const sel = this.selectedFaces.has(i);
        const fm  = new THREE.Mesh(tfg, new THREE.MeshBasicMaterial({
          color:       sel ? FACE_SEL_COLOR : 0xffffff,
          transparent: true,
          opacity:     sel ? FACE_SEL_OP : FACE_IDLE_OP,
          side:        THREE.DoubleSide,
          depthTest:   false,
        }));
        fm.renderOrder        = 997;
        fm.userData.faceIndex = i;
        fg2.add(fm);
        this._faceMeshes.push(fm);
      }
    }
  }

  _clearHelpers() {
    [this.vertGroup, this.edgeGroup, this.faceGroup].forEach(g => {
      while (g.children.length) g.remove(g.children[0]);
    });
    this._vertMeshes = [];
    this._edgeLines  = null;
    this._edgeKeys   = [];
    this._faceMeshes = [];
  }

  // ── Picking ────────────────────────────────────────────────────────────────
  _getNDC(e) {
    return new THREE.Vector2(
      ( e.clientX / window.innerWidth)  * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
  }

  _pickVertex(e) {
    this._raycaster.setFromCamera(this._getNDC(e), this.camera);
    const hits = this._raycaster.intersectObjects(this._vertMeshes);
    return hits.length > 0 ? hits[0].object.userData.vertIndex : -1;
  }

  _pickEdge(e) {
    if (!this._edgeLines) return -1;
    this._raycaster.setFromCamera(this._getNDC(e), this.camera);
    const ray     = this._raycaster.ray;
    const posAttr = this._edgeLines.geometry.attributes.position;
    const THRESH  = 0.08 * 0.08;
    let bestDist  = THRESH, bestIdx = -1;
    for (let i = 0; i < this._edgeKeys.length; i++) {
      const va = new THREE.Vector3().fromBufferAttribute(posAttr, i * 2);
      const vb = new THREE.Vector3().fromBufferAttribute(posAttr, i * 2 + 1);
      const d  = ray.distanceSqToSegment(va, vb);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
  }

  _pickFace(e) {
    this._raycaster.setFromCamera(this._getNDC(e), this.camera);
    const hits = this._raycaster.intersectObjects(this._faceMeshes);
    return hits.length > 0 ? hits[0].object.userData.faceIndex : -1;
  }

  // ── Input ──────────────────────────────────────────────────────────────────
  _onPointerDown(e) {
    if (e.button !== 0) return;
    if (this._gizmo.axis !== null) return; // gizmo axis hovered — let it handle

    if (this.subMode === 'vertex') {
      const vi = this._pickVertex(e);
      if (vi >= 0) {
        e.shiftKey
          ? (this.selectedVerts.has(vi) ? this.selectedVerts.delete(vi) : this.selectedVerts.add(vi))
          : (this.selectedVerts.clear(), this.selectedVerts.add(vi));
      } else {
        if (!e.shiftKey) this.selectedVerts.clear();
      }
    } else if (this.subMode === 'edge') {
      const ei = this._pickEdge(e);
      if (ei >= 0) {
        const key = this._edgeKeys[ei];
        e.shiftKey
          ? (this.selectedEdges.has(key) ? this.selectedEdges.delete(key) : this.selectedEdges.add(key))
          : (this.selectedEdges.clear(), this.selectedEdges.add(key));
      } else {
        if (!e.shiftKey) this.selectedEdges.clear();
      }
    } else if (this.subMode === 'face') {
      const fi = this._pickFace(e);
      if (fi >= 0) {
        e.shiftKey
          ? (this.selectedFaces.has(fi) ? this.selectedFaces.delete(fi) : this.selectedFaces.add(fi))
          : (this.selectedFaces.clear(), this.selectedFaces.add(fi));
      } else {
        if (!e.shiftKey) this.selectedFaces.clear();
      }
    }

    this._buildHelpers();
    this._updateGizmo();
  }

  _onKeyDown(e) {
    if (e.code === 'Numpad1') { this.setSubMode('vertex'); this._syncToolbarButtons('vertex'); return; }
    if (e.code === 'Numpad2') { this.setSubMode('edge');   this._syncToolbarButtons('edge');   return; }
    if (e.code === 'Numpad3') { this.setSubMode('face');   this._syncToolbarButtons('face');   return; }
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
      e.stopImmediatePropagation();
      this.undo();
    }
  }

  _syncToolbarButtons(mode) {
    const map = { vertex: 'msub-vert', edge: 'msub-edge', face: 'msub-face' };
    document.querySelectorAll('#mesh-toolbar .sub-mode-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(map[mode])?.classList.add('active');
  }
}

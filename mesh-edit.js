import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const VERT_COLOR       = 0xffaa00;
const VERT_SEL         = 0xff3300;
const EDGE_COLOR       = 0x44aaff;
const EDGE_SEL         = 0xff6600;
const FACE_COLOR       = 0x4466ff;
const FACE_SEL         = 0xff4422;
const FACE_OPACITY     = 0.18;
const FACE_SEL_OPACITY = 0.45;
const VERT_RADIUS      = 0.035;

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

    // Mesh-local undo stack
    this._undoStack = [];

    this._dragging   = false;
    this._dragStart  = null;
    this._dragPlane  = new THREE.Plane();
    this._lastDragPt = null;
    this._raycaster  = new THREE.Raycaster();

    this._vertMeshes = [];
    this._edgeKeys   = [];
    this._faceMeshes = [];

    // Gizmo: a TransformControls attached to a proxy Object3D
    this._gizmoProxy = new THREE.Object3D();
    scene.add(this._gizmoProxy);
    this._gizmo = new TransformControls(camera, renderer.domElement);
    this._gizmo.setMode('translate');
    this._gizmo.setSize(0.6);
    scene.add(this._gizmo);
    this._gizmoActive = false;

    this._gizmo.addEventListener('mouseDown', () => {
      this.orbit.enabled = false;
      // snapshot positions before drag
      this._snapPositions();
    });
    this._gizmo.addEventListener('mouseUp', () => {
      this.orbit.enabled = true;
      // push undo entry after drag completes
      this._pushUndo();
    });
    this._gizmo.addEventListener('change', () => {
      if (!this._gizmo.dragging) return;
      this._applyGizmoDelta();
    });

    this._prevGizmoPos = new THREE.Vector3();

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp   = this._onPointerUp.bind(this);
    this._onKeyDown     = this._onKeyDown.bind(this);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  enter(mesh) {
    this.targetMesh = mesh;
    this.selectedVerts.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this._undoStack = [];
    this._buildHelpers();
    this._hideGizmo();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup',   this._onPointerUp);
    window.addEventListener('keydown',     this._onKeyDown);
  }

  exit() {
    this._clearHelpers();
    this._hideGizmo();
    this.targetMesh = null;
    this.selectedVerts.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();

    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup',   this._onPointerUp);
    window.removeEventListener('keydown',     this._onKeyDown);
  }

  setSubMode(mode) {
    this.subMode = mode;
    this.selectedVerts.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this._buildHelpers();
    this._hideGizmo();
  }

  // Returns true if this editor consumed the Ctrl+Z
  undo() {
    if (this._undoStack.length === 0) return false;
    const snap = this._undoStack.pop();
    const pos  = this.targetMesh.geometry.attributes.position;
    for (let i = 0; i < snap.length; i++) {
      pos.setXYZ(i, snap[i].x, snap[i].y, snap[i].z);
    }
    pos.needsUpdate = true;
    this.targetMesh.geometry.computeVertexNormals();
    this._buildHelpers();
    this._updateGizmo();
    return true;
  }

  // ── Undo helpers ──────────────────────────────────────────────────────────
  _snapPositions() {
    const pos  = this.targetMesh.geometry.attributes.position;
    const snap = [];
    for (let i = 0; i < pos.count; i++) {
      snap.push(new THREE.Vector3().fromBufferAttribute(pos, i));
    }
    this._pendingSnap = snap;
  }

  _pushUndo() {
    if (this._pendingSnap) {
      this._undoStack.push(this._pendingSnap);
      this._pendingSnap = null;
    }
  }

  // ── Gizmo ─────────────────────────────────────────────────────────────────
  _showGizmo(worldPos) {
    this._gizmoProxy.position.copy(worldPos);
    this._prevGizmoPos.copy(worldPos);
    this._gizmo.attach(this._gizmoProxy);
    this._gizmoActive = true;
  }

  _hideGizmo() {
    this._gizmo.detach();
    this._gizmoActive = false;
  }

  _updateGizmo() {
    const centroid = this._getSelectionCentroid();
    if (centroid) {
      this._showGizmo(centroid);
    } else {
      this._hideGizmo();
    }
  }

  _getSelectionCentroid() {
    const pos = this.targetMesh?.geometry?.attributes?.position;
    const mat = this.targetMesh?.matrixWorld;
    if (!pos || !mat) return null;

    const verts = this._getSelectedVertIndices();
    if (verts.size === 0) return null;

    const c = new THREE.Vector3();
    verts.forEach(vi => {
      c.add(new THREE.Vector3().fromBufferAttribute(pos, vi).applyMatrix4(mat));
    });
    c.divideScalar(verts.size);
    return c;
  }

  _getSelectedVertIndices() {
    const out = new Set();
    if (this.subMode === 'vertex') {
      this.selectedVerts.forEach(vi => out.add(vi));
    } else if (this.subMode === 'edge') {
      this.selectedEdges.forEach(key => {
        const [a, b] = key.split('_').map(Number);
        out.add(a); out.add(b);
      });
    } else if (this.subMode === 'face') {
      const index = this.targetMesh.geometry.index;
      if (index) {
        this.selectedFaces.forEach(fi => {
          out.add(index.getX(fi * 3));
          out.add(index.getX(fi * 3 + 1));
          out.add(index.getX(fi * 3 + 2));
        });
      }
    }
    return out;
  }

  _applyGizmoDelta() {
    const delta = this._gizmoProxy.position.clone().sub(this._prevGizmoPos);
    if (delta.lengthSq() < 1e-10) return;
    this._prevGizmoPos.copy(this._gizmoProxy.position);

    const invMat    = this.targetMesh.matrixWorld.clone().invert();
    const localDelta = delta.clone().transformDirection(invMat);

    const pos         = this.targetMesh.geometry.attributes.position;
    const vertsToMove = this._getSelectedVertIndices();

    vertsToMove.forEach(vi => {
      pos.setX(vi, pos.getX(vi) + localDelta.x);
      pos.setY(vi, pos.getY(vi) + localDelta.y);
      pos.setZ(vi, pos.getZ(vi) + localDelta.z);
    });

    pos.needsUpdate = true;
    this.targetMesh.geometry.computeVertexNormals();
    this._buildHelpers();

    // Keep gizmo proxy at same world pos (it moved itself)
    this._prevGizmoPos.copy(this._gizmoProxy.position);
  }

  // ── Build helpers ──────────────────────────────────────────────────────────
  _buildHelpers() {
    this._clearHelpers();
    if (!this.targetMesh) return;

    const geo = this.targetMesh.geometry;
    const pos = geo.attributes.position;
    const mat = this.targetMesh.matrixWorld;

    // ── Vertices ──
    this._vertMeshes = [];
    const sphereGeo  = new THREE.SphereGeometry(VERT_RADIUS, 8, 6);

    for (let i = 0; i < pos.count; i++) {
      const wv  = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mat);
      const sel = this.selectedVerts.has(i);
      const m   = new THREE.Mesh(
        sphereGeo,
        new THREE.MeshBasicMaterial({
          color: sel ? VERT_SEL : VERT_COLOR,
          depthTest: false,
          transparent: true,
          opacity: 0.95,
        })
      );
      m.position.copy(wv);
      m.renderOrder = 999;
      m.userData.vertIndex = i;
      this.vertGroup.add(m);
      this._vertMeshes.push(m);
    }

    // ── Edges: only real mesh edges (no diagonals) ──
    // Strategy: collect edges from the index, but deduplicate so we only draw
    // shared edges once. We also skip internal diagonals added by Three.js
    // subdivision by detecting them: a "real" edge on a box is shared by exactly
    // 2 triangles that together form a quad. We keep all edges but avoid
    // rendering both diagonals of a quad face.
    const index = geo.index;
    const edgeMap = new Map(); // key → { count, a, b }
    this._edgeKeys = [];

    const registerEdge = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!edgeMap.has(key)) edgeMap.set(key, { count: 0, a, b });
      edgeMap.get(key).count++;
    };

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i), b = index.getX(i+1), c = index.getX(i+2);
        registerEdge(a, b); registerEdge(b, c); registerEdge(c, a);
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        registerEdge(i, i+1); registerEdge(i+1, i+2); registerEdge(i+2, i);
      }
    }

    // Only keep boundary edges (count === 1) and shared edges (count === 2).
    // Edges shared by MORE than 2 triangles are internal diagonals — skip them.
    const edgeVerts  = [];
    const edgeColors = [];

    edgeMap.forEach(({ count, a, b }, key) => {
      if (count > 2) return; // skip internal diagonals
      const va  = new THREE.Vector3().fromBufferAttribute(pos, a).applyMatrix4(mat);
      const vb  = new THREE.Vector3().fromBufferAttribute(pos, b).applyMatrix4(mat);
      edgeVerts.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
      this._edgeKeys.push(key);
      const sel = this.selectedEdges.has(key);
      const c   = new THREE.Color(sel ? EDGE_SEL : EDGE_COLOR);
      edgeColors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    });

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3));
    edgeGeo.setAttribute('color',    new THREE.Float32BufferAttribute(edgeColors, 3));

    this._edgeLines = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: false,
      transparent: true,
      opacity: 0.85,
    }));
    this._edgeLines.renderOrder = 998;
    this.edgeGroup.add(this._edgeLines);

    // ── Faces: one mesh per triangle + a slight solid shell for thickness ──
    this._faceMeshes = [];
    const faceGroup2 = new THREE.Group();
    this.faceGroup.add(faceGroup2);

    // Slight thickness shell on the whole mesh so it's never invisible edge-on
    if (index) {
      const shellGeo = geo.clone().applyMatrix4(mat);
      const shell    = new THREE.Mesh(shellGeo, new THREE.MeshBasicMaterial({
        color: 0x222244,
        side: THREE.BackSide,
        transparent: true,
        opacity: 0.18,
        depthTest: true,
      }));
      shell.scale.setScalar(1.012); // just a hair bigger — gives the "thickness" illusion
      shell.renderOrder = 996;
      faceGroup2.add(shell);
    }

    if (index) {
      for (let i = 0; i < index.count / 3; i++) {
        const ai = index.getX(i*3), bi = index.getX(i*3+1), ci = index.getX(i*3+2);
        const va = new THREE.Vector3().fromBufferAttribute(pos, ai).applyMatrix4(mat);
        const vb = new THREE.Vector3().fromBufferAttribute(pos, bi).applyMatrix4(mat);
        const vc = new THREE.Vector3().fromBufferAttribute(pos, ci).applyMatrix4(mat);

        const fg = new THREE.BufferGeometry();
        fg.setAttribute('position', new THREE.Float32BufferAttribute([
          va.x, va.y, va.z,
          vb.x, vb.y, vb.z,
          vc.x, vc.y, vc.z,
        ], 3));
        fg.setIndex([0, 1, 2]);

        const sel = this.selectedFaces.has(i);
        const fm  = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
          color: sel ? FACE_SEL : FACE_COLOR,
          transparent: true,
          opacity: sel ? FACE_SEL_OPACITY : FACE_OPACITY,
          side: THREE.DoubleSide,
          depthTest: false,
        }));
        fm.renderOrder = 997;
        fm.userData.faceIndex = i;
        faceGroup2.add(fm);
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

  // ── Helpers ────────────────────────────────────────────────────────────────
  _getNDC(e) {
    return new THREE.Vector2(
      ( e.clientX / window.innerWidth)  * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1
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
    const THRESH  = 0.08;
    let bestDist  = THRESH * THRESH, bestIdx = -1;

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

  // ── Keyboard (scoped to mesh mode) ────────────────────────────────────────
  _onKeyDown(e) {
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
      e.stopImmediatePropagation(); // prevent object-mode undo from firing
      this.undo();
    }
  }

  // ── Pointer events ────────────────────────────────────────────────────────
  _onPointerDown(e) {
    if (e.button !== 0) return;
    if (this._gizmo.dragging) return; // gizmo is handling it
    this._dragStart = { x: e.clientX, y: e.clientY };
    this._dragging  = false;

    if (this.subMode === 'vertex') {
      const vi = this._pickVertex(e);
      if (vi >= 0) {
        if (e.shiftKey) {
          this.selectedVerts.has(vi) ? this.selectedVerts.delete(vi) : this.selectedVerts.add(vi);
        } else {
          this.selectedVerts.clear();
          this.selectedVerts.add(vi);
        }
      } else {
        if (!e.shiftKey) this.selectedVerts.clear();
      }
      this._buildHelpers();
      this._updateGizmo();
    }

    if (this.subMode === 'edge') {
      const ei = this._pickEdge(e);
      if (ei >= 0) {
        const key = this._edgeKeys[ei];
        if (e.shiftKey) {
          this.selectedEdges.has(key) ? this.selectedEdges.delete(key) : this.selectedEdges.add(key);
        } else {
          this.selectedEdges.clear();
          this.selectedEdges.add(key);
        }
      } else {
        if (!e.shiftKey) this.selectedEdges.clear();
      }
      this._buildHelpers();
      this._updateGizmo();
    }

    if (this.subMode === 'face') {
      const fi = this._pickFace(e);
      if (fi >= 0) {
        if (e.shiftKey) {
          this.selectedFaces.has(fi) ? this.selectedFaces.delete(fi) : this.selectedFaces.add(fi);
        } else {
          this.selectedFaces.clear();
          this.selectedFaces.add(fi);
        }
      } else {
        if (!e.shiftKey) this.selectedFaces.clear();
      }
      this._buildHelpers();
      this._updateGizmo();
    }
  }

  _onPointerMove(e) {
    // nothing needed — gizmo handles its own drag
  }

  _onPointerUp(e) {
    if (e.button !== 0) return;
    this._dragging   = false;
    this._lastDragPt = null;
    if (!this._gizmo.dragging) this.orbit.enabled = true;
  }
}

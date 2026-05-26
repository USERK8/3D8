import * as THREE from 'three';

const VERT_COLOR   = 0xffaa00;
const VERT_SEL     = 0xff3300;
const EDGE_COLOR   = 0x44aaff;
const EDGE_SEL     = 0xff6600;
const FACE_COLOR   = 0x4466ff;
const FACE_SEL     = 0xff4422;
const FACE_OPACITY = 0.18;
const FACE_SEL_OPACITY = 0.45;
const VERT_RADIUS  = 0.035;   // world-space sphere radius

export class MeshEditor {
  constructor(scene, camera, renderer, orbitControls) {
    this.scene     = scene;
    this.camera    = camera;
    this.renderer  = renderer;
    this.orbit     = orbitControls;
    this.targetMesh = null;

    this.vertGroup = new THREE.Group();
    this.edgeGroup = new THREE.Group();
    this.faceGroup = new THREE.Group();
    scene.add(this.vertGroup, this.edgeGroup, this.faceGroup);

    this.subMode = 'vertex';

    this.selectedVerts = new Set();
    this.selectedEdges = new Set();  // edge key "a_b"
    this.selectedFaces = new Set();  // face (triangle) index

    this._dragging   = false;
    this._dragStart  = null;
    this._dragPlane  = new THREE.Plane();
    this._lastDragPt = null;
    this._raycaster  = new THREE.Raycaster();
    this._raycaster.params.Points.threshold = 0.08;

    // Internal maps rebuilt on _buildHelpers
    this._vertMeshes = [];   // [i] → sphere Mesh for vertex i
    this._edgeKeys   = [];   // [i] → "a_b" key for edge i (line pair i*2, i*2+1)
    this._faceTriMap = [];   // [faceIndex] → triangle index in geometry

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp   = this._onPointerUp.bind(this);
  }

  enter(mesh) {
    this.targetMesh = mesh;
    this.selectedVerts.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this._buildHelpers();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup',   this._onPointerUp);
  }

  exit() {
    this._clearHelpers();
    this.targetMesh = null;
    this.selectedVerts.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();

    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup',   this._onPointerUp);
  }

  setSubMode(mode) {
    this.subMode = mode;
    this.selectedVerts.clear();
    this.selectedEdges.clear();
    this.selectedFaces.clear();
    this._buildHelpers();
  }

  // ── Build helpers ──────────────────────────────────────────────────────────
  _buildHelpers() {
    this._clearHelpers();
    if (!this.targetMesh) return;

    const geo = this.targetMesh.geometry;
    const pos = geo.attributes.position;
    const mat = this.targetMesh.matrixWorld;

    // ── Vertices: one sphere mesh per unique vertex ──
    this._vertMeshes = [];
    const sphereGeo = new THREE.SphereGeometry(VERT_RADIUS, 8, 6);

    for (let i = 0; i < pos.count; i++) {
      const wv = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mat);
      const selected = this.selectedVerts.has(i);
      const m = new THREE.Mesh(
        sphereGeo,
        new THREE.MeshBasicMaterial({
          color: selected ? VERT_SEL : VERT_COLOR,
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

    // ── Edges: LineSegments with unique deduplication ──
    const index = geo.index;
    const edgeSet = new Set();
    const edgeVerts = [];
    this._edgeKeys = [];

    const addEdge = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      const va = new THREE.Vector3().fromBufferAttribute(pos, a).applyMatrix4(mat);
      const vb = new THREE.Vector3().fromBufferAttribute(pos, b).applyMatrix4(mat);
      edgeVerts.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
      this._edgeKeys.push(key);
    };

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i), b = index.getX(i+1), c = index.getX(i+2);
        addEdge(a, b); addEdge(b, c); addEdge(c, a);
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        addEdge(i, i+1); addEdge(i+1, i+2); addEdge(i+2, i);
      }
    }

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3));

    // Build per-edge color buffer
    const edgeColors = [];
    for (let i = 0; i < this._edgeKeys.length; i++) {
      const sel = this.selectedEdges.has(this._edgeKeys[i]);
      const c = sel ? new THREE.Color(EDGE_SEL) : new THREE.Color(EDGE_COLOR);
      edgeColors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    edgeGeo.setAttribute('color', new THREE.Float32BufferAttribute(edgeColors, 3));

    this._edgeLines = new THREE.LineSegments(
      edgeGeo,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        depthTest: false,
        transparent: true,
        opacity: 0.85,
        linewidth: 1,
      })
    );
    this._edgeLines.renderOrder = 998;
    this.edgeGroup.add(this._edgeLines);

    // ── Face overlays: one Mesh per triangle for independent selection ──
    this._faceMeshes = [];
    this._faceGroup2 = new THREE.Group();
    this.faceGroup.add(this._faceGroup2);

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

        const selected = this.selectedFaces.has(i);
        const fm = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
          color: selected ? FACE_SEL : FACE_COLOR,
          transparent: true,
          opacity: selected ? FACE_SEL_OPACITY : FACE_OPACITY,
          side: THREE.DoubleSide,
          depthTest: false,
        }));
        fm.renderOrder = 997;
        fm.userData.faceIndex = i;
        this._faceGroup2.add(fm);
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

  // ── NDC helper ────────────────────────────────────────────────────────────
  _getNDC(e) {
    return new THREE.Vector2(
      ( e.clientX / window.innerWidth)  * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1
    );
  }

  // ── Picking ───────────────────────────────────────────────────────────────
  _pickVertex(e) {
    this._raycaster.setFromCamera(this._getNDC(e), this.camera);
    const hits = this._raycaster.intersectObjects(this._vertMeshes);
    if (hits.length === 0) return -1;
    return hits[0].object.userData.vertIndex;
  }

  _pickEdge(e) {
    // Find the nearest edge line pair by screen-space distance to the click
    this._raycaster.setFromCamera(this._getNDC(e), this.camera);
    const ray = this._raycaster.ray;

    if (!this._edgeLines) return -1;
    const posAttr = this._edgeLines.geometry.attributes.position;

    let bestDist = Infinity;
    let bestIdx  = -1;
    const PICK_THRESHOLD = 0.08; // world-space line proximity

    for (let i = 0; i < this._edgeKeys.length; i++) {
      const va = new THREE.Vector3().fromBufferAttribute(posAttr, i * 2);
      const vb = new THREE.Vector3().fromBufferAttribute(posAttr, i * 2 + 1);

      // Closest point on ray to line segment
      const d = ray.distanceSqToSegment(va, vb);
      if (d < PICK_THRESHOLD * PICK_THRESHOLD && d < bestDist) {
        bestDist = d;
        bestIdx  = i;
      }
    }
    return bestIdx;
  }

  _pickFace(e) {
    this._raycaster.setFromCamera(this._getNDC(e), this.camera);
    const hits = this._raycaster.intersectObjects(this._faceMeshes);
    if (hits.length === 0) return -1;
    return hits[0].object.userData.faceIndex;
  }

  // ── Pointer events ────────────────────────────────────────────────────────
  _onPointerDown(e) {
    if (e.button !== 0) return;
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
        this._buildHelpers();

        const pos   = this.targetMesh.geometry.attributes.position;
        const vWorld = new THREE.Vector3().fromBufferAttribute(pos, vi)
          .applyMatrix4(this.targetMesh.matrixWorld);
        this._dragPlane.setFromNormalAndCoplanarPoint(
          this.camera.getWorldDirection(new THREE.Vector3()).negate(), vWorld
        );
        this._dragging = true;
        this.orbit.enabled = false;
      } else {
        if (!e.shiftKey) { this.selectedVerts.clear(); this._buildHelpers(); }
      }
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
        this._buildHelpers();

        // Drag plane: midpoint of edge, camera-facing
        const posAttr = this._edgeLines
          ? this._edgeLines.geometry.attributes.position
          : null;
        if (posAttr) {
          const va = new THREE.Vector3().fromBufferAttribute(posAttr, ei * 2);
          const vb = new THREE.Vector3().fromBufferAttribute(posAttr, ei * 2 + 1);
          const mid = va.clone().add(vb).multiplyScalar(0.5);
          this._dragPlane.setFromNormalAndCoplanarPoint(
            this.camera.getWorldDirection(new THREE.Vector3()).negate(), mid
          );
          this._dragging = true;
          this.orbit.enabled = false;
        }
      } else {
        if (!e.shiftKey) { this.selectedEdges.clear(); this._buildHelpers(); }
      }
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
        this._collectFaceVerts();
        this._buildHelpers();

        // Drag plane: use hit point
        this._raycaster.setFromCamera(this._getNDC(e), this.camera);
        const hits = this._raycaster.intersectObjects(this._faceMeshes);
        if (hits.length) {
          this._dragPlane.setFromNormalAndCoplanarPoint(
            this.camera.getWorldDirection(new THREE.Vector3()).negate(), hits[0].point
          );
        }
        this._dragging = true;
        this.orbit.enabled = false;
      } else {
        if (!e.shiftKey) { this.selectedFaces.clear(); this._buildHelpers(); }
      }
    }
  }

  _collectFaceVerts() {
    this._faceVertIndices = new Set();
    const index = this.targetMesh.geometry.index;
    if (!index) return;
    this.selectedFaces.forEach(fi => {
      this._faceVertIndices.add(index.getX(fi * 3));
      this._faceVertIndices.add(index.getX(fi * 3 + 1));
      this._faceVertIndices.add(index.getX(fi * 3 + 2));
    });
  }

  _collectEdgeVerts() {
    this._edgeVertIndices = new Set();
    this.selectedEdges.forEach(key => {
      const [a, b] = key.split('_').map(Number);
      this._edgeVertIndices.add(a);
      this._edgeVertIndices.add(b);
    });
  }

  _onPointerMove(e) {
    if (!this._dragging) return;

    const dx = e.clientX - this._dragStart.x;
    const dy = e.clientY - this._dragStart.y;
    if (Math.sqrt(dx*dx + dy*dy) < 2) return;

    this._raycaster.setFromCamera(this._getNDC(e), this.camera);
    const pt = new THREE.Vector3();
    if (!this._raycaster.ray.intersectPlane(this._dragPlane, pt)) return;

    if (!this._lastDragPt) { this._lastDragPt = pt.clone(); return; }
    const delta = pt.clone().sub(this._lastDragPt);
    this._lastDragPt = pt.clone();

    const invMat = this.targetMesh.matrixWorld.clone().invert();
    const localDelta = delta.clone().transformDirection(invMat);

    const pos = this.targetMesh.geometry.attributes.position;

    let vertsToMove;
    if (this.subMode === 'vertex') {
      vertsToMove = this.selectedVerts;
    } else if (this.subMode === 'edge') {
      this._collectEdgeVerts();
      vertsToMove = this._edgeVertIndices;
    } else {
      vertsToMove = this._faceVertIndices || new Set();
    }

    vertsToMove.forEach(vi => {
      pos.setX(vi, pos.getX(vi) + localDelta.x);
      pos.setY(vi, pos.getY(vi) + localDelta.y);
      pos.setZ(vi, pos.getZ(vi) + localDelta.z);
    });

    pos.needsUpdate = true;
    this.targetMesh.geometry.computeVertexNormals();
    this._buildHelpers();
  }

  _onPointerUp(e) {
    if (e.button !== 0) return;
    this._dragging    = false;
    this._lastDragPt  = null;
    this.orbit.enabled = true;
  }
}

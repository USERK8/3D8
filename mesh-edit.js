import * as THREE from 'three';

const VERT_SIZE   = 0.04;
const VERT_COLOR  = 0xffaa00;
const VERT_SEL    = 0xff3300;
const EDGE_COLOR  = 0x44aaff;
const FACE_COLOR  = 0x4466ff;
const FACE_OPACITY = 0.18;

export class MeshEditor {
  constructor(scene, camera, renderer, orbitControls) {
    this.scene          = scene;
    this.camera         = camera;
    this.renderer       = renderer;
    this.orbit          = orbitControls;
    this.targetMesh     = null;

    // Sub-element groups
    this.vertGroup  = new THREE.Group();
    this.edgeGroup  = new THREE.Group();
    this.faceGroup  = new THREE.Group();
    scene.add(this.vertGroup, this.edgeGroup, this.faceGroup);

    // Edit mode: 'vertex' | 'edge' | 'face'
    this.subMode = 'vertex';

    // Selected sub-elements (indices)
    this.selectedVerts = new Set();
    this.selectedEdges = new Set(); // edge key "a_b"
    this.selectedFaces = new Set(); // face index

    // Drag state
    this._dragging    = false;
    this._dragStart   = null;   // {x,y} screen
    this._dragPlane   = new THREE.Plane();
    this._dragOffset  = new THREE.Vector3();
    this._hitPoint    = new THREE.Vector3();
    this._raycaster   = new THREE.Raycaster();
    this._raycaster.params.Points.threshold = 0.08;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp   = this._onPointerUp.bind(this);
  }

  // ── Enter mesh edit mode on a mesh ──
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

  // ── Exit mesh edit mode ──
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

  // ── Build vertex/edge/face visual helpers ──
  _buildHelpers() {
    this._clearHelpers();
    if (!this.targetMesh) return;

    const geo  = this.targetMesh.geometry;
    const pos  = geo.attributes.position;
    const mat  = this.targetMesh.matrixWorld;

    // ── Vertices ──
    const vertGeo = new THREE.BufferGeometry();
    const verts   = [];
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mat);
      verts.push(v.x, v.y, v.z);
    }
    vertGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this._vertPoints = new THREE.Points(
      vertGeo,
      new THREE.PointsMaterial({ color: VERT_COLOR, size: VERT_SIZE * 2, sizeAttenuation: false, depthTest: false })
    );
    this._vertPoints.renderOrder = 999;
    this.vertGroup.add(this._vertPoints);

    // ── Edges ──
    const index = geo.index;
    const edgeSet = new Set();
    const edgeVerts = [];

    const addEdge = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      const va = new THREE.Vector3().fromBufferAttribute(pos, a).applyMatrix4(mat);
      const vb = new THREE.Vector3().fromBufferAttribute(pos, b).applyMatrix4(mat);
      edgeVerts.push(va.x, va.y, va.z, vb.x, vb.y, vb.z);
    };

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i), b = index.getX(i+1), c = index.getX(i+2);
        addEdge(a, b); addEdge(b, c); addEdge(c, a);
      }
    }

    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3));
    this._edgeLines = new THREE.LineSegments(
      edgeGeo,
      new THREE.LineBasicMaterial({ color: EDGE_COLOR, depthTest: false, transparent: true, opacity: 0.7 })
    );
    this._edgeLines.renderOrder = 998;
    this.edgeGroup.add(this._edgeLines);

    // ── Face overlays (invisible click targets + subtle tint) ──
    if (index) {
      const faceGeo = geo.clone();
      // transform to world space
      faceGeo.applyMatrix4(mat);
      this._faceMesh = new THREE.Mesh(
        faceGeo,
        new THREE.MeshBasicMaterial({
          color: FACE_COLOR, transparent: true, opacity: FACE_OPACITY,
          side: THREE.DoubleSide, depthTest: false
        })
      );
      this._faceMesh.renderOrder = 997;
      this.faceGroup.add(this._faceMesh);
    }
  }

  _clearHelpers() {
    [this.vertGroup, this.edgeGroup, this.faceGroup].forEach(g => {
      while (g.children.length) g.remove(g.children[0]);
    });
    this._vertPoints = null;
    this._edgeLines  = null;
    this._faceMesh   = null;
  }

  // ── Raycasting helpers ──
  _getNDC(e) {
    return new THREE.Vector2(
      ( e.clientX / window.innerWidth)  * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1
    );
  }

  _pickVertex(e) {
    this._raycaster.setFromCamera(this._getNDC(e), this.camera);
    if (!this._vertPoints) return -1;
    const hits = this._raycaster.intersectObject(this._vertPoints);
    return hits.length > 0 ? hits[0].index : -1;
  }

  _pickFace(e) {
    this._raycaster.setFromCamera(this._getNDC(e), this.camera);
    if (!this._faceMesh) return -1;
    const hits = this._raycaster.intersectObject(this._faceMesh);
    return hits.length > 0 ? hits[0].faceIndex : -1;
  }

  // ── Pointer events ──
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
        this._updateVertColors();
        // Set drag plane perpendicular to camera through the vertex
        const pos = this.targetMesh.geometry.attributes.position;
        const vWorld = new THREE.Vector3().fromBufferAttribute(pos, vi)
          .applyMatrix4(this.targetMesh.matrixWorld);
        this._dragPlane.setFromNormalAndCoplanarPoint(
          this.camera.getWorldDirection(new THREE.Vector3()).negate(), vWorld
        );
        this._dragging = true;
        this.orbit.enabled = false;
      } else {
        if (!e.shiftKey) { this.selectedVerts.clear(); this._updateVertColors(); }
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
        // Collect verts of selected faces for drag
        this._collectFaceVerts();
        this._dragging = true;
        this.orbit.enabled = false;
        // drag plane: face normal
        const face = this._faceMesh.geometry.index
          ? null : null; // use camera normal instead
        const hit = this._raycaster.intersectObject(this._faceMesh);
        if (hit.length) {
          this._dragPlane.setFromNormalAndCoplanarPoint(
            this.camera.getWorldDirection(new THREE.Vector3()).negate(), hit[0].point
          );
        }
      } else {
        if (!e.shiftKey) { this.selectedFaces.clear(); }
      }
    }
  }

  _collectFaceVerts() {
    // For face drag: gather all vertex indices belonging to selected faces
    this._faceVertIndices = new Set();
    const index = this.targetMesh.geometry.index;
    if (!index) return;
    this.selectedFaces.forEach(fi => {
      this._faceVertIndices.add(index.getX(fi * 3));
      this._faceVertIndices.add(index.getX(fi * 3 + 1));
      this._faceVertIndices.add(index.getX(fi * 3 + 2));
    });
  }

  _onPointerMove(e) {
    if (!this._dragging) return;

    const dx = e.clientX - this._dragStart.x;
    const dy = e.clientY - this._dragStart.y;
    if (Math.sqrt(dx*dx + dy*dy) < 2) return;

    // Find world position on drag plane
    this._raycaster.setFromCamera(this._getNDC(e), this.camera);
    const pt = new THREE.Vector3();
    this._raycaster.ray.intersectPlane(this._dragPlane, pt);
    if (!pt) return;

    // Compute delta from last frame
    if (!this._lastDragPt) { this._lastDragPt = pt.clone(); return; }
    const delta = pt.clone().sub(this._lastDragPt);
    this._lastDragPt = pt.clone();

    // Convert world delta to local space of mesh
    const invMat = this.targetMesh.matrixWorld.clone().invert();
    const localDelta = delta.clone().transformDirection(invMat);

    const pos = this.targetMesh.geometry.attributes.position;

    const vertsToMove = this.subMode === 'vertex'
      ? this.selectedVerts
      : this._faceVertIndices || new Set();

    vertsToMove.forEach(vi => {
      pos.setX(vi, pos.getX(vi) + localDelta.x);
      pos.setY(vi, pos.getY(vi) + localDelta.y);
      pos.setZ(vi, pos.getZ(vi) + localDelta.z);
    });

    pos.needsUpdate = true;
    this.targetMesh.geometry.computeVertexNormals();

    // Rebuild helpers to reflect new positions
    this._buildHelpers();
    this._updateVertColors();
  }

  _onPointerUp(e) {
    if (e.button !== 0) return;
    this._dragging    = false;
    this._lastDragPt  = null;
    this.orbit.enabled = true;
  }

  _updateVertColors() {
    if (!this._vertPoints) return;
    const pos   = this.targetMesh.geometry.attributes.position;
    const mat   = this.targetMesh.matrixWorld;
    const count = pos.count;
    const colors = [];

    for (let i = 0; i < count; i++) {
      if (this.selectedVerts.has(i)) {
        colors.push(1, 0.2, 0); // selected: orange-red
      } else {
        colors.push(1, 0.67, 0); // default: yellow-orange
      }
    }

    this._vertPoints.geometry.setAttribute(
      'color', new THREE.Float32BufferAttribute(colors, 3)
    );
    this._vertPoints.material.vertexColors = true;
    this._vertPoints.material.needsUpdate  = true;
  }
}

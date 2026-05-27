/**
 * MeshRenderer — render layer.
 *
 * Owns all Three.js scene objects for the mesh-edit overlay:
 *   • InstancedMesh for vertex dots (one draw call for all verts)
 *   • Persistent LineSegments with a reused BufferGeometry for edges
 *   • MeshBasicMaterial overlays for selected-edge cylinders + face highlights
 *
 * Consumes MeshData.dirty flags and updates ONLY the GPU data that changed.
 * Never recreates objects from scratch unless topology changes (e.g. vert count).
 *
 * Rule: if dirty.positions  → update instance matrices + edge positions
 *       if dirty.selection  → update instance colours + edge colours + face opacities
 *       if dirty.topology   → full overlay rebuild (rare — only on enter/undo)
 */

import * as THREE from 'three';

const COLOR = {
  VERT_IDLE     : new THREE.Color(0x222222),
  VERT_SEL      : new THREE.Color(0xff8800),
  EDGE_IDLE     : new THREE.Color(0x333333),
  EDGE_SEL      : new THREE.Color(0xff8800),
  FACE_SEL_COLOR: new THREE.Color(0xff8800),
  FACE_SEL_OP   : 0.30,
};

const VERT_RADIUS = 0.055;
const _mat4 = new THREE.Matrix4();
const _col  = new THREE.Color();

export class MeshRenderer {
  constructor(scene) {
    this.scene = scene;

    // Groups — keep overlay objects out of main scene graph
    this._grpVert = new THREE.Group();
    this._grpEdge = new THREE.Group();
    this._grpFace = new THREE.Group();
    scene.add(this._grpVert, this._grpEdge, this._grpFace);

    // Shared geometry for instanced vertex dots
    this._vertGeo      = new THREE.SphereGeometry(VERT_RADIUS, 7, 5);
    this._vertInstanced = null;   // THREE.InstancedMesh, rebuilt on topology change

    // Persistent edge line buffer
    this._edgeLines    = null;    // THREE.LineSegments
    this._edgePosAttr  = null;    // Float32BufferAttribute (reused)
    this._edgeColAttr  = null;

    // Selected-edge cylinders (rebuilt on selection change, but only for sel edges)
    this._edgeCylGroup = new THREE.Group();
    this._grpEdge.add(this._edgeCylGroup);

    // Face overlay meshes — rebuilt on topology change only
    this._faceMeshes    = [];
    this._faceHitMeshes = [];

    // Snapshot of last vert count / edge count so we know when to hard-rebuild
    this._lastVertCount = -1;
    this._lastEdgeCount = -1;
    this._lastFaceCount = -1;
    this._lastSubMode   = null;

    // Visible edge entries from last topology build
    this.edgeEntries = []; // [{ key, a, b }] — shared with interaction layer
  }

  // ── Main update — call once per frame (or after mutations) ─────────────

  update(data) {
    const subModeChanged = data.subMode !== this._lastSubMode;

    // Topology rebuild: vert count changed, edge map changed, or subMode switched
    if (data.dirty.topology || subModeChanged
        || data.pos.count !== this._lastVertCount
        || data.faceCount !== this._lastFaceCount) {
      this._rebuildTopology(data);
      data.dirty.topology  = false;
      data.dirty.positions = false;
      data.dirty.selection = false;
      this._lastSubMode = data.subMode;
      return;
    }

    // Positions changed (drag in progress or undo) — update GPU attributes
    if (data.dirty.positions) {
      this._updatePositions(data);
      data.dirty.positions = false;
      // Selection colours don't need separate update — positions implies selection too
      data.dirty.selection = false;
      return;
    }

    // Only selection changed (click to select/deselect) — cheapest update
    if (data.dirty.selection) {
      this._updateSelectionColors(data);
      data.dirty.selection = false;
    }
  }

  // ── Full topology rebuild (rare) ───────────────────────────────────────

  _rebuildTopology(data) {
    this._clearVerts();
    this._clearEdges();
    this._clearFaces();

    const { pos, geo, mesh, subMode, edgeMap, _isQuadDiag } = data;
    const mat   = mesh.matrixWorld;
    const index = geo.index;

    // ── Vertex InstancedMesh ──
    if (subMode === 'vertex') {
      const count = pos.count;
      const iMesh = new THREE.InstancedMesh(this._vertGeo,
        new THREE.MeshBasicMaterial({ depthTest: true }),
        count);
      iMesh.renderOrder = 999;
      iMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      const colArr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const wp = data.vertWorldPos(i);
        _mat4.identity().setPosition(wp.x, wp.y, wp.z);
        iMesh.setMatrixAt(i, _mat4);
        const sel = data.selVerts.has(i);
        const c   = sel ? COLOR.VERT_SEL : COLOR.VERT_IDLE;
        colArr[i * 3] = c.r; colArr[i * 3 + 1] = c.g; colArr[i * 3 + 2] = c.b;
      }
      const colAttr = new THREE.InstancedBufferAttribute(colArr, 3);
      iMesh.geometry = iMesh.geometry.clone(); // need per-instance color attr
      iMesh.geometry.setAttribute('instanceColor', colAttr);
      iMesh.material.vertexColors = true; // uses instanceColor automatically

      iMesh.instanceMatrix.needsUpdate = true;
      this._grpVert.add(iMesh);
      this._vertInstanced = iMesh;
      this._lastVertCount = count;
    }

    // ── Edge LineSegments (single persistent buffer) ──
    this.edgeEntries = [];
    const positions = [];
    const colors    = [];

    edgeMap.forEach((e, key) => {
      if (_isQuadDiag(e)) return;
      const wa = data.vertWorldPos(e.a);
      const wb = data.vertWorldPos(e.b);
      positions.push(wa.x, wa.y, wa.z, wb.x, wb.y, wb.z);
      const sel = (subMode === 'edge') && data.selEdges.has(key);
      const c   = sel ? COLOR.EDGE_SEL : COLOR.EDGE_IDLE;
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
      this.edgeEntries.push({ key, a: e.a, b: e.b });
    });

    if (positions.length) {
      const eg = new THREE.BufferGeometry();
      this._edgePosAttr = new THREE.Float32BufferAttribute(positions, 3);
      this._edgeColAttr = new THREE.Float32BufferAttribute(colors, 3);
      this._edgePosAttr.setUsage(THREE.DynamicDrawUsage);
      this._edgeColAttr.setUsage(THREE.DynamicDrawUsage);
      eg.setAttribute('position', this._edgePosAttr);
      eg.setAttribute('color',    this._edgeColAttr);
      this._edgeLines = new THREE.LineSegments(eg,
        new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true }));
      this._edgeLines.renderOrder = 1;
      this._grpEdge.add(this._edgeLines);
    }

    this._lastEdgeCount = this.edgeEntries.length;

    // Selected-edge cylinders
    if (subMode === 'edge') this._rebuildEdgeCylinders(data);

    // ── Face overlays ──
    if (subMode === 'face' && index) {
      const fc = data.faceCount;
      for (let fi = 0; fi < fc; fi++) {
        const ai = index.getX(fi * 3), bi = index.getX(fi * 3 + 1), ci = index.getX(fi * 3 + 2);
        const va = data.vertWorldPos(ai);
        const vb = data.vertWorldPos(bi);
        const vc = data.vertWorldPos(ci);
        const verts = [va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z];
        const sel = data.selFaces.has(fi);

        const fg = new THREE.BufferGeometry();
        fg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        fg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        fg.setIndex([0, 1, 2]);
        const fm = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
          color: COLOR.FACE_SEL_COLOR, transparent: true,
          opacity: sel ? COLOR.FACE_SEL_OP : 0.0,
          side: THREE.DoubleSide, depthTest: true,
        }));
        fm.renderOrder = 2;
        fm.userData.faceIndex = fi;
        this._grpFace.add(fm);
        this._faceMeshes.push(fm);

        const hg = new THREE.BufferGeometry();
        hg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        hg.setIndex([0, 1, 2]);
        const hm = new THREE.Mesh(hg, new THREE.MeshBasicMaterial({
          transparent: true, opacity: 0, side: THREE.DoubleSide, depthTest: true,
        }));
        hm.renderOrder = 1;
        hm.userData.faceIndex = fi;
        this._grpFace.add(hm);
        this._faceHitMeshes.push(hm);
      }
      this._lastFaceCount = fc;
    }
  }

  // ── Positions update — only moves GPU data, no object recreation ───────

  _updatePositions(data) {
    const { pos, geo, mesh, subMode, edgeMap, _isQuadDiag, selVerts, selEdges, selFaces } = data;
    const index = geo.index;

    // Instanced mesh: update matrices only
    if (this._vertInstanced && subMode === 'vertex') {
      for (let i = 0; i < pos.count; i++) {
        const wp = data.vertWorldPos(i);
        _mat4.identity().setPosition(wp.x, wp.y, wp.z);
        this._vertInstanced.setMatrixAt(i, _mat4);
      }
      this._vertInstanced.instanceMatrix.needsUpdate = true;
    }

    // Edge lines: update position attribute in-place
    if (this._edgePosAttr) {
      let idx = 0;
      this.edgeEntries.forEach(({ a, b }) => {
        const wa = data.vertWorldPos(a);
        const wb = data.vertWorldPos(b);
        this._edgePosAttr.setXYZ(idx * 2,     wa.x, wa.y, wa.z);
        this._edgePosAttr.setXYZ(idx * 2 + 1, wb.x, wb.y, wb.z);
        idx++;
      });
      this._edgePosAttr.needsUpdate = true;
    }

    // Edge cylinders: only if in edge mode + something selected
    if (subMode === 'edge' && selEdges.size > 0) this._rebuildEdgeCylinders(data);

    // Face overlays: update position attributes in-place
    if (subMode === 'face' && index) {
      const allFace = [...this._faceMeshes, ...this._faceHitMeshes];
      allFace.forEach(fm => {
        const fi   = fm.userData.faceIndex;
        const ai   = index.getX(fi * 3), bi = index.getX(fi * 3 + 1), ci = index.getX(fi * 3 + 2);
        const va   = data.vertWorldPos(ai);
        const vb   = data.vertWorldPos(bi);
        const vc   = data.vertWorldPos(ci);
        const attr = fm.geometry.attributes.position;
        attr.setXYZ(0, va.x, va.y, va.z);
        attr.setXYZ(1, vb.x, vb.y, vb.z);
        attr.setXYZ(2, vc.x, vc.y, vc.z);
        attr.needsUpdate = true;
        fm.geometry.computeBoundingSphere();
      });
    }
  }

  // ── Selection colour update — cheapest path ────────────────────────────

  _updateSelectionColors(data) {
    const { subMode, selVerts, selEdges, selFaces } = data;

    // Vertex instance colours
    if (this._vertInstanced && subMode === 'vertex') {
      const colAttr = this._vertInstanced.geometry.getAttribute('instanceColor');
      if (colAttr) {
        for (let i = 0; i < data.pos.count; i++) {
          const c = selVerts.has(i) ? COLOR.VERT_SEL : COLOR.VERT_IDLE;
          colAttr.setXYZ(i, c.r, c.g, c.b);
        }
        colAttr.needsUpdate = true;
      }
    }

    // Edge line colours
    if (this._edgeColAttr) {
      this.edgeEntries.forEach(({ key }, idx) => {
        const sel = (subMode === 'edge') && selEdges.has(key);
        const c   = sel ? COLOR.EDGE_SEL : COLOR.EDGE_IDLE;
        this._edgeColAttr.setXYZ(idx * 2,     c.r, c.g, c.b);
        this._edgeColAttr.setXYZ(idx * 2 + 1, c.r, c.g, c.b);
      });
      this._edgeColAttr.needsUpdate = true;
    }

    // Selected edge cylinders
    if (subMode === 'edge') this._rebuildEdgeCylinders(data);

    // Face opacities
    this._faceMeshes.forEach(fm => {
      fm.material.opacity = selFaces.has(fm.userData.faceIndex) ? COLOR.FACE_SEL_OP : 0.0;
    });
  }

  // ── Selected-edge thick highlight cylinders (small set, fast) ──────────

  _rebuildEdgeCylinders(data) {
    while (this._edgeCylGroup.children.length)
      this._edgeCylGroup.remove(this._edgeCylGroup.children[0]);

    data.selEdges.forEach(key => {
      const entry = this.edgeEntries.find(e => e.key === key);
      if (!entry) return;
      const wa  = data.vertWorldPos(entry.a);
      const wb  = data.vertWorldPos(entry.b);
      const dir = new THREE.Vector3(wb.x - wa.x, wb.y - wa.y, wb.z - wa.z);
      const len = dir.length();
      if (len < 1e-6) return;
      const mid = new THREE.Vector3(
        (wa.x + wb.x) / 2, (wa.y + wb.y) / 2, (wa.z + wb.z) / 2);
      const cyl = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.012, len, 6),
        new THREE.MeshBasicMaterial({ color: 0xff8800, depthTest: true })
      );
      cyl.position.copy(mid);
      cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      cyl.renderOrder = 2;
      this._edgeCylGroup.add(cyl);
    });
  }

  // ── Accessors for interaction layer ────────────────────────────────────

  getVertInstanced()  { return this._vertInstanced; }
  getFaceHitMeshes()  { return this._faceHitMeshes; }
  getEdgeLineSet()    { return this._edgeLines; }
  getEdgePosAttr()    { return this._edgePosAttr; }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  _clearVerts() {
    while (this._grpVert.children.length) this._grpVert.remove(this._grpVert.children[0]);
    this._vertInstanced = null;
  }

  _clearEdges() {
    while (this._edgeCylGroup.children.length)
      this._edgeCylGroup.remove(this._edgeCylGroup.children[0]);
    if (this._edgeLines) {
      this._grpEdge.remove(this._edgeLines);
      this._edgeLines.geometry.dispose();
      this._edgeLines = null;
    }
    this._edgePosAttr = null;
    this._edgeColAttr = null;
    this.edgeEntries  = [];
  }

  _clearFaces() {
    this._faceMeshes.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
    this._faceHitMeshes.forEach(m => { m.geometry.dispose(); m.material.dispose(); });
    while (this._grpFace.children.length) this._grpFace.remove(this._grpFace.children[0]);
    this._faceMeshes    = [];
    this._faceHitMeshes = [];
  }

  dispose() {
    this._clearVerts();
    this._clearEdges();
    this._clearFaces();
    this._vertGeo.dispose();
    this.scene.remove(this._grpVert, this._grpEdge, this._grpFace);
  }
}

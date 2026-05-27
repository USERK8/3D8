/**
 * MeshEditor — interaction layer / coordinator.
 *
 * Wires together:
 *   MeshData       (data layer  — topology, selection, undo, mutations)
 *   MeshRenderer   (render layer — GPU buffers, dirty-flag updates)
 *
 * Owns only: gizmo (TransformControls), picking raycaster, pointer/key
 * event handlers, proportional-editing UI, box-select UI.
 *
 * After any mutation: set data.dirty.* flags, then call renderer.update(data).
 * The renderer only touches GPU data that actually changed.
 */

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { MeshData }     from './mesh-data.js';
import { MeshRenderer } from './mesh-renderer.js';

const GIZMO_SIZE   = 0.75;
const EDGE_PICK_PX = 14;

export class MeshEditor {
  constructor(scene, camera, renderer, orbitControls) {
    this.scene    = scene;
    this.camera   = camera;
    this.renderer = renderer;
    this.orbit    = orbitControls;

    this._data     = null;   // MeshData  — set in enter()
    this._renderer = new MeshRenderer(scene);

    this._rc    = new THREE.Raycaster();
    this._proxy = new THREE.Object3D();
    scene.add(this._proxy);

    // Gizmo
    this._gizmo = new TransformControls(camera, renderer.domElement);
    this._gizmo.setMode('translate');
    this._gizmo.setSize(GIZMO_SIZE);
    this._gizmo.translationSnap = null;
    this._gizmo.rotationSnap    = null;
    this._gizmo.scaleSnap       = null;
    scene.add(this._gizmo);

    this._dragBase = new THREE.Vector3();

    this._gizmo.addEventListener('mouseDown', () => {
      this.orbit.enabled = false;
      this._data.saveSnap();
      this._dragBase.copy(this._proxy.position);
    });

    this._gizmo.addEventListener('change', () => {
      if (!this._gizmo.dragging) return;
      this._applyGizmoDelta();
    });

    this._gizmo.addEventListener('mouseUp', () => {
      this.orbit.enabled = true;
      this._data.commitSnap();
      this._reanchorGizmo();
    });

    // Proportional editing
    this._propEnabled = false;
    this._propRadius  = 1.0;
    this._propCircle  = null;

    this._onWheel = (e) => {
      if (!this._propEnabled) return;
      e.preventDefault();
      e.stopPropagation();
      this._propRadius = Math.max(0.05, this._propRadius * (e.deltaY > 0 ? 1.15 : 0.87));
      this._updatePropCircle();
      if (this._gizmo.dragging) this._applyGizmoDelta();
    };

    // Box select
    this._box = { active: false, pending: false, start: null, end: null, div: null };

    // Direct-drag state
    this._dragOffsets      = null;
    this._dragPlane        = null;
    this._dragStartClient  = null;
    this._isDragging       = false;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp   = this._onPointerUp.bind(this);
    this._onKeyDown     = this._onKeyDown.bind(this);
    this._onWheel       = this._onWheel.bind(this);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  enter(mesh) {
    this._data = new MeshData(mesh);

    this._origSide        = mesh.material.side;
    this._origDepthWrite  = mesh.material.depthWrite;
    mesh.material.side        = THREE.DoubleSide;
    mesh.material.depthWrite  = true;
    mesh.material.needsUpdate = true;

    this._data.dirty.topology = true;
    this._renderer.update(this._data);
    this._hideGizmo();

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this._onPointerDown);
    el.addEventListener('pointermove', this._onPointerMove);
    el.addEventListener('pointerup',   this._onPointerUp);
    el.addEventListener('wheel',       this._onWheel, { passive: false });
    window.addEventListener('keydown', this._onKeyDown);
  }

  exit() {
    if (!this._data) return;
    const mesh = this._data.mesh;
    mesh.material.side        = this._origSide       ?? THREE.FrontSide;
    mesh.material.depthWrite  = this._origDepthWrite ?? true;
    mesh.material.needsUpdate = true;

    this._renderer.dispose();
    // Recreate renderer so it's ready for next enter()
    this._renderer = new MeshRenderer(this.scene);

    this._data = null;
    this._hideGizmo();
    this._endBoxSelect();
    this._removePropCircle();

    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerup',   this._onPointerUp);
    el.removeEventListener('wheel',       this._onWheel);
    window.removeEventListener('keydown', this._onKeyDown);
  }

  setSubMode(mode) {
    if (!this._data) return;
    this._data.setSubMode(mode);
    this._data.dirty.topology = true;
    this._renderer.update(this._data);
    this._updateGizmo();
  }

  setGizmoMode(mode) { this._gizmo.setMode(mode); }

  undo() {
    if (!this._data) return false;
    const ok = this._data.undo();
    if (ok) {
      this._renderer.update(this._data);
      this._updateGizmo();
    }
    return ok;
  }

  // ── Gizmo delta application ──────────────────────────────────────────────

  _applyGizmoDelta() {
    if (!this._data?._preSnap) return;
    const totalWorld = this._proxy.position.clone().sub(this._dragBase);
    if (totalWorld.lengthSq() < 1e-18) return;

    const selected = this._data.selectedVertIndices();
    let weights;

    if (this._propEnabled) {
      weights = this._data.buildPropWeights(selected, this._propRadius);
      this._updatePropCircle();
    } else {
      weights = new Map();
      selected.forEach(i => weights.set(i, 1.0));
    }

    this._data.applyWeightedDelta(totalWorld, weights);
    this._renderer.update(this._data);
  }

  // ── Gizmo position management ────────────────────────────────────────────

  _showGizmo(worldPos) {
    this._proxy.position.set(worldPos.x, worldPos.y, worldPos.z);
    this._dragBase.set(worldPos.x, worldPos.y, worldPos.z);
    this._gizmo.attach(this._proxy);
  }

  _hideGizmo() { this._gizmo.detach(); }

  _updateGizmo() {
    const c = this._data?.selectionCentroid();
    if (c) this._showGizmo(new THREE.Vector3(c.x, c.y, c.z));
    else   this._hideGizmo();
  }

  _reanchorGizmo() {
    const c = this._data?.selectionCentroid();
    if (c) {
      // Move proxy to new centroid WITHOUT resetting dragBase mid-gizmo
      this._proxy.position.set(c.x, c.y, c.z);
      this._dragBase.set(c.x, c.y, c.z);
      this._gizmo.attach(this._proxy);
    } else {
      this._hideGizmo();
    }
  }

  // ── Proportional editing UI ──────────────────────────────────────────────

  _updatePropCircle() {
    if (!this._propEnabled || !this._data) { this._removePropCircle(); return; }
    const c = this._data.selectionCentroid();
    if (!c) { this._removePropCircle(); return; }

    const centroid = new THREE.Vector3(c.x, c.y, c.z);
    const ndc = centroid.clone().project(this.camera);
    const cx  = ( ndc.x + 1) / 2 * window.innerWidth;
    const cy  = (-ndc.y + 1) / 2 * window.innerHeight;

    const right = new THREE.Vector3();
    this.camera.getWorldDirection(right);
    right.cross(this.camera.up).normalize().multiplyScalar(this._propRadius);
    const edgePt  = centroid.clone().add(right).project(this.camera);
    const ex      = ( edgePt.x + 1) / 2 * window.innerWidth;
    const screenR = Math.abs(ex - cx);

    if (!this._propCircle) {
      this._propCircle = document.createElement('div');
      this._propCircle.style.cssText = [
        'position:fixed','pointer-events:none','z-index:9998',
        'border:1.5px solid rgba(255,136,0,0.7)','border-radius:50%',
        'box-shadow:0 0 6px rgba(255,136,0,0.3)','transform:translate(-50%,-50%)',
      ].join(';');
      document.body.appendChild(this._propCircle);
    }
    Object.assign(this._propCircle.style, {
      left: cx + 'px', top: cy + 'px',
      width: screenR * 2 + 'px', height: screenR * 2 + 'px',
    });
  }

  _removePropCircle() {
    if (this._propCircle) { this._propCircle.remove(); this._propCircle = null; }
  }

  // ── Picking ──────────────────────────────────────────────────────────────

  _ndc(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - r.left) / r.width)  * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
  }

  _pickVert(e) {
    const instanced = this._renderer.getVertInstanced();
    if (!instanced) return -1;
    this._rc.setFromCamera(this._ndc(e.clientX, e.clientY), this.camera);
    const hits = this._rc.intersectObject(instanced);
    return hits.length ? hits[0].instanceId : -1;
  }

  _pickEdge(clientX, clientY) {
    const posAttr  = this._renderer.getEdgePosAttr();
    const entries  = this._renderer.edgeEntries;
    if (!posAttr || !entries.length) return -1;
    let bestDist = EDGE_PICK_PX, bestIdx = -1;
    for (let i = 0; i < entries.length; i++) {
      const wa = new THREE.Vector3().fromBufferAttribute(posAttr, i * 2);
      const wb = new THREE.Vector3().fromBufferAttribute(posAttr, i * 2 + 1);
      const sa = worldToScreen(wa, this.camera);
      const sb = worldToScreen(wb, this.camera);
      const d  = screenDistToSeg(clientX, clientY, sa.x, sa.y, sb.x, sb.y);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    return bestIdx;
  }

  _pickFace(e) {
    const hits = this._renderer.getFaceHitMeshes();
    if (!hits.length) return -1;
    this._rc.setFromCamera(this._ndc(e.clientX, e.clientY), this.camera);
    const result = this._rc.intersectObjects(hits);
    return result.length ? result[0].object.userData.faceIndex : -1;
  }

  // ── Pointer events ───────────────────────────────────────────────────────

  _onPointerDown(e) {
    if (e.button !== 0 || !this._data) return;
    if (this._gizmo.axis !== null) return;
    if (this._box.pending) { this._startBoxSelect(e); return; }

    const d = this._data;
    let hitSomething = false;

    if (d.subMode === 'vertex') {
      const vi = this._pickVert(e);
      if (vi >= 0) {
        if (!e.shiftKey && !d.selVerts.has(vi)) { d.selVerts.clear(); d.selVerts.add(vi); }
        else if (e.shiftKey) d.selVerts.has(vi) ? d.selVerts.delete(vi) : d.selVerts.add(vi);
        d.dirty.selection = true;
        hitSomething = d.selVerts.size > 0;
      }
    } else if (d.subMode === 'edge') {
      const ei = this._pickEdge(e.clientX, e.clientY);
      if (ei >= 0) {
        const key = this._renderer.edgeEntries[ei].key;
        if (!e.shiftKey && !d.selEdges.has(key)) { d.selEdges.clear(); d.selEdges.add(key); }
        else if (e.shiftKey) d.selEdges.has(key) ? d.selEdges.delete(key) : d.selEdges.add(key);
        d.dirty.selection = true;
        hitSomething = d.selEdges.size > 0;
      }
    } else if (d.subMode === 'face') {
      const fi = this._pickFace(e);
      if (fi >= 0) {
        if (!e.shiftKey && !d.selFaces.has(fi)) { d.selFaces.clear(); d.selFaces.add(fi); }
        else if (e.shiftKey) d.selFaces.has(fi) ? d.selFaces.delete(fi) : d.selFaces.add(fi);
        d.dirty.selection = true;
        hitSomething = d.selFaces.size > 0;
      }
    }

    this._renderer.update(d);
    this._updateGizmo();

    if (!hitSomething) {
      if (!e.shiftKey) { d.clearSelection(); this._renderer.update(d); this._hideGizmo(); }
      return;
    }

    // Prepare direct drag
    const c = d.selectionCentroid();
    if (!c) return;

    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    this._dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      camDir, new THREE.Vector3(c.x, c.y, c.z));

    // Per-vert world offset from centroid
    const pos = d.pos, mat = d.mesh.matrixWorld;
    this._dragOffsets = new Map();
    d.selectedVertIndices().forEach(vi => {
      const wp = new THREE.Vector3().fromBufferAttribute(pos, vi).applyMatrix4(mat);
      this._dragOffsets.set(vi, { x: wp.x - c.x, y: wp.y - c.y, z: wp.z - c.z });
    });

    this._dragStartClient = { x: e.clientX, y: e.clientY };
    this._isDragging = false;
    d.saveSnap();
    this.orbit.enabled = false;
    e.stopPropagation();
  }

  _onPointerMove(e) {
    if (this._box.active) { this._updateBoxSelect(e); return; }
    if (!this._dragOffsets || !this._data) return;

    if (!this._isDragging) {
      const dx = e.clientX - this._dragStartClient.x;
      const dy = e.clientY - this._dragStartClient.y;
      if (Math.hypot(dx, dy) < 4) return;
      this._isDragging = true;
    }

    this._rc.setFromCamera(this._ndc(e.clientX, e.clientY), this.camera);
    const newCentroid = new THREE.Vector3();
    if (!this._rc.ray.intersectPlane(this._dragPlane, newCentroid)) return;

    const d      = this._data;
    const pos    = d.pos;
    const invMat = d.mesh.matrixWorld.clone().invert();

    this._dragOffsets.forEach((offset, vi) => {
      const wx = newCentroid.x + offset.x;
      const wy = newCentroid.y + offset.y;
      const wz = newCentroid.z + offset.z;
      const e4 = invMat.elements;
      const wt = 1 / (e4[3]*wx + e4[7]*wy + e4[11]*wz + e4[15]);
      pos.setXYZ(vi,
        (e4[0]*wx + e4[4]*wy + e4[8] *wz + e4[12]) * wt,
        (e4[1]*wx + e4[5]*wy + e4[9] *wz + e4[13]) * wt,
        (e4[2]*wx + e4[6]*wy + e4[10]*wz + e4[14]) * wt,
      );
    });

    pos.needsUpdate = true;
    d.geo.computeVertexNormals();
    d.dirty.positions = true;
    this._renderer.update(d);
    this._updateGizmo();
    e.stopPropagation();
  }

  _onPointerUp(e) {
    if (this._box.active) { this._endBoxSelect(e); return; }
    if (!this._dragOffsets) return;

    if (!this._isDragging) {
      this._data.discardSnap();
      this._doClickSelect(e);
    } else {
      this._data.commitSnap();
    }

    this._dragOffsets     = null;
    this._dragPlane       = null;
    this._isDragging      = false;
    this.orbit.enabled    = true;
  }

  _doClickSelect(e) {
    if (!this._data) return;
    const d = this._data, shift = e.shiftKey;

    if (d.subMode === 'vertex') {
      const vi = this._pickVert(e);
      if (vi >= 0) {
        shift ? (d.selVerts.has(vi) ? d.selVerts.delete(vi) : d.selVerts.add(vi))
              : (d.selVerts.clear(), d.selVerts.add(vi));
      } else if (!shift) d.selVerts.clear();
      d.dirty.selection = true;
    } else if (d.subMode === 'edge') {
      const ei = this._pickEdge(e.clientX, e.clientY);
      if (ei >= 0) {
        const key = this._renderer.edgeEntries[ei].key;
        shift ? (d.selEdges.has(key) ? d.selEdges.delete(key) : d.selEdges.add(key))
              : (d.selEdges.clear(), d.selEdges.add(key));
      } else if (!shift) d.selEdges.clear();
      d.dirty.selection = true;
    } else if (d.subMode === 'face') {
      const fi = this._pickFace(e);
      if (fi >= 0) {
        shift ? (d.selFaces.has(fi) ? d.selFaces.delete(fi) : d.selFaces.add(fi))
              : (d.selFaces.clear(), d.selFaces.add(fi));
      } else if (!shift) d.selFaces.clear();
      d.dirty.selection = true;
    }

    this._renderer.update(d);
    this._updateGizmo();
  }

  // ── Box select ───────────────────────────────────────────────────────────

  _startBoxSelect(e) {
    this._box.pending = false;
    this._box.active  = true;
    this._box.start   = { x: e.clientX, y: e.clientY };
    this._box.end     = { x: e.clientX, y: e.clientY };
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;border:1px solid #ff8800;' +
      'background:rgba(255,136,0,0.08);pointer-events:none;z-index:9999;';
    document.body.appendChild(div);
    this._box.div = div;
    this._updateBoxSelect(e);
  }

  _updateBoxSelect(e) {
    if (!this._box.div) return;
    this._box.end = { x: e.clientX, y: e.clientY };
    const s = this._box.start, en = this._box.end;
    Object.assign(this._box.div.style, {
      left: Math.min(s.x, en.x) + 'px', top:    Math.min(s.y, en.y) + 'px',
      width: Math.abs(en.x - s.x) + 'px', height: Math.abs(en.y - s.y) + 'px',
    });
  }

  _endBoxSelect(e) {
    if (!this._box.active || !this._data) return;
    this._box.active = false;
    if (this._box.div) { this._box.div.remove(); this._box.div = null; }

    const d   = this._data;
    const s   = this._box.start, en = this._box.end ?? s;
    const additive = e?.shiftKey;
    const minX = Math.min(s.x, en.x), maxX = Math.max(s.x, en.x);
    const minY = Math.min(s.y, en.y), maxY = Math.max(s.y, en.y);

    const r     = this.renderer.domElement.getBoundingClientRect();
    const projM = new THREE.Matrix4().multiplyMatrices(
      this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const pos   = d.pos;
    const mat   = d.mesh.matrixWorld;
    const index = d.geo.index;

    const inBox = (i) => {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i)
        .applyMatrix4(mat).applyMatrix4(projM);
      const sx = ( v.x + 1) / 2 * r.width  + r.left;
      const sy = (-v.y + 1) / 2 * r.height + r.top;
      return sx >= minX && sx <= maxX && sy >= minY && sy <= maxY;
    };

    if (!additive) { d.selVerts.clear(); d.selEdges.clear(); d.selFaces.clear(); }

    if (d.subMode === 'vertex') {
      for (let i = 0; i < pos.count; i++) if (inBox(i)) d.selVerts.add(i);
    } else if (d.subMode === 'edge') {
      this._renderer.edgeEntries.forEach(({ key, a, b }) => {
        if (inBox(a) && inBox(b)) d.selEdges.add(key);
      });
    } else if (d.subMode === 'face' && index) {
      for (let fi = 0; fi < d.faceCount; fi++) {
        const ai = index.getX(fi*3), bi = index.getX(fi*3+1), ci = index.getX(fi*3+2);
        if (inBox(ai) && inBox(bi) && inBox(ci)) d.selFaces.add(fi);
      }
    }

    d.dirty.selection = true;
    this._renderer.update(d);
    this._updateGizmo();
  }

  // ── Key events ───────────────────────────────────────────────────────────

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
    if (e.key === 'a' || e.key === 'A') { this._data?.toggleSelectAll(); this._renderer.update(this._data); this._updateGizmo(); return; }
    if ((e.key === 'b' || e.key === 'B') && !this._box.active) { this._box.pending = true; return; }

    if (e.key === 'o' || e.key === 'O') {
      this._propEnabled = !this._propEnabled;
      if (!this._propEnabled) this._removePropCircle();
      else this._updatePropCircle();
      this._showToast(this._propEnabled
        ? 'Proportional Editing ON  (scroll to resize)'
        : 'Proportional Editing OFF');
      return;
    }

    if (e.key === 'Escape') {
      if (this._box.pending) { this._box.pending = false; return; }
      if (this._data) {
        this._data.clearSelection();
        this._renderer.update(this._data);
        this._hideGizmo();
      }
    }
  }

  _showToast(msg) {
    let toast = document.getElementById('prop-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'prop-toast';
      toast.style.cssText = [
        'position:fixed','bottom:48px','left:50%','transform:translateX(-50%)',
        'background:rgba(20,20,30,0.85)','color:#ff8800','padding:6px 16px',
        'border-radius:6px','font-size:13px','pointer-events:none',
        'z-index:10000','border:1px solid rgba(255,136,0,0.4)',
        'transition:opacity 0.3s',
      ].join(';');
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 2000);
  }

  _syncModeButtons(mode) {
    const map = { vertex: 'msub-vert', edge: 'msub-edge', face: 'msub-face' };
    document.querySelectorAll('#mesh-toolbar .tool-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(map[mode])?.classList.add('active');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function worldToScreen(worldPos, camera) {
  const v = worldPos.clone().project(camera);
  return {
    x: ( v.x + 1) / 2 * window.innerWidth,
    y: (-v.y + 1) / 2 * window.innerHeight,
  };
}

function screenDistToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

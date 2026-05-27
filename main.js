import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';

import { createScene, createCamera, createRenderer, createLights, createGrid } from './scene.js';
import { createControls, handleResize } from './controls.js';
import { ObjectManager } from './objects.js';
import { exportModel } from './export.js';
import { setupImporter } from './import.js';
import { MeshEditor } from './mesh-edit.js';
import { History } from './history.js';

const canvas = document.getElementById('viewport');
const scene  = createScene();
const camera = createCamera();
const renderer = createRenderer(canvas);
renderer.autoClear = false;

createLights(scene);
createGrid(scene);

const orbit     = createControls(camera, canvas);
const objManager = new ObjectManager(scene);
const clock     = new THREE.Clock();
const meshEditor = new MeshEditor(scene, camera, renderer, orbit, appHistory);

const appHistory = new History();
let   dragStartState = null;

// ── Gizmo ──
const gizmoCanvas   = document.getElementById('gizmo');
const gizmoRenderer = new THREE.WebGLRenderer({ canvas: gizmoCanvas, alpha: true, antialias: true });
gizmoRenderer.setSize(120, 120);
const viewHelper = new ViewHelper(camera, gizmoCanvas);
gizmoCanvas.addEventListener('pointerup',   e => { e.stopPropagation(); viewHelper.handleClick(e); });
gizmoCanvas.addEventListener('pointerdown', e => e.stopPropagation());

// ── Transform controls ──
const transformControl = new TransformControls(camera, renderer.domElement);
scene.add(transformControl);

transformControl.addEventListener('dragging-changed', (event) => {
  const mesh = transformControl.object;
  if (!mesh) return;
  if (event.value) {
    dragStartState = { pos: mesh.position.clone(), rot: mesh.rotation.clone(), scale: mesh.scale.clone() };
  } else if (dragStartState) {
    const newState = { pos: mesh.position.clone(), rot: mesh.rotation.clone(), scale: mesh.scale.clone() };
    appHistory.push({ type: 'transform', mesh, oldState: dragStartState, newState });
    dragStartState = null;
  }
});

// ── UI elements ──
const objCountEl = document.getElementById('obj-count');
const selInfoEl  = document.getElementById('sel-info');
const fpsEl      = document.getElementById('fps');
const camInfoEl  = document.getElementById('cam-info');
const addMenu    = document.getElementById('add-menu');
const toolBtns   = document.querySelectorAll('.tool-btn');
const hListEl    = document.getElementById('h-list');

let currentTool = 'translate';

function setTool(toolName) {
  currentTool = toolName;
  toolBtns.forEach(btn => btn.classList.remove('active'));
  const idMap = { select: 'btn-select', translate: 'btn-move', rotate: 'btn-rotate', scale: 'btn-scale' };
  document.getElementById(idMap[toolName] || 'btn-select').classList.add('active');

  const sel = objManager.getSelected();
  if (toolName === 'select') transformControl.detach();
  else if (sel) { transformControl.attach(sel); transformControl.setMode(toolName); }
}

document.getElementById('btn-select').onclick = () => setTool('select');
document.getElementById('btn-move').onclick   = () => setTool('translate');
document.getElementById('btn-rotate').onclick = () => setTool('rotate');
document.getElementById('btn-scale').onclick  = () => setTool('scale');

// ════════════════════════════════════════════════
// MODE SWITCHING  (Layout ↔ Mesh)
// ════════════════════════════════════════════════
let currentMode = 'object';

const toolbar      = document.getElementById('toolbar');
const meshToolbar  = document.getElementById('mesh-toolbar');
const modeBtnObj   = document.getElementById('mode-object');
const modeBtnMesh  = document.getElementById('mode-mesh');

function enterObjectMode() {
  currentMode = 'object';
  modeBtnObj.classList.add('active');
  modeBtnMesh.classList.remove('active');
  toolbar.style.display = '';
  meshToolbar.style.display = 'none';
  meshEditor.exit();
  updateUI();
}

function enterMeshMode() {
  const sel = objManager.getSelected();
  if (!sel) {
    const el = document.createElement('div');
    el.className = 'export-toast';
    el.style.borderColor = 'rgba(255,50,50,0.4)';
    el.style.color = '#f88';
    el.textContent = '✗ Select an object first';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
    return;
  }
  currentMode = 'mesh';
  modeBtnMesh.classList.add('active');
  modeBtnObj.classList.remove('active');
  toolbar.style.display = 'none';
  meshToolbar.style.display = 'flex';
  transformControl.detach();
  meshEditor.enter(sel);
  setMeshSubMode('vertex');
  updateUI();
}

modeBtnObj.addEventListener('click', enterObjectMode);
modeBtnMesh.addEventListener('click', enterMeshMode);

// Tab toggles between Layout and Mesh mode
window.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    currentMode === 'object' ? enterMeshMode() : enterObjectMode();
  }
});

// Mesh sub-mode buttons
const msubVert = document.getElementById('msub-vert');
const msubEdge = document.getElementById('msub-edge');
const msubFace = document.getElementById('msub-face');

function setMeshSubMode(mode) {
  [msubVert, msubEdge, msubFace].forEach(b => b.classList.remove('active'));
  ({ vertex: msubVert, edge: msubEdge, face: msubFace })[mode].classList.add('active');
  meshEditor.setSubMode(mode);
}

msubVert.addEventListener('click', () => setMeshSubMode('vertex'));
msubEdge.addEventListener('click', () => setMeshSubMode('edge'));
msubFace.addEventListener('click', () => setMeshSubMode('face'));

// ════════════════════════════════════════════════════
// SELECTION — LMB click, Shift+LMB multi-select,
//             LMB drag = box-select
// ════════════════════════════════════════════════════
const raycaster  = new THREE.Raycaster();
const mouse      = new THREE.Vector2();

const boxEl = document.createElement('div');
boxEl.style.cssText = `
  position:fixed; border:1px solid rgba(100,160,255,0.8);
  background:rgba(100,160,255,0.08); pointer-events:none;
  display:none; z-index:900;
`;
document.body.appendChild(boxEl);

let lmbDown       = false;
let lmbStartX     = 0;
let lmbStartY     = 0;
let isDraggingBox = false;
const BOX_THRESHOLD = 5;

const multiSelected = new Set();

function screenToNDC(x, y) {
  return new THREE.Vector2(
    ( x / window.innerWidth)  * 2 - 1,
    -(y / window.innerHeight) * 2 + 1
  );
}

function raycastAt(x, y) {
  const ndc = screenToNDC(x, y);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(objManager.getObjects());
  return hits.length > 0 ? hits[0].object : null;
}

function applyHighlight(obj) {
  if (!obj.userData.originalColor) {
    obj.userData.originalColor    = obj.material.color.clone();
    if (obj.material.emissive)
      obj.userData.originalEmissive = obj.material.emissive.clone();
  }
  obj.material.color.set(0xff0033);
  if (obj.material.emissive) obj.material.emissive.set(0x440011);
}

function removeHighlight(obj) {
  if (obj.userData.originalColor) {
    obj.material.color.copy(obj.userData.originalColor);
    if (obj.material.emissive && obj.userData.originalEmissive)
      obj.material.emissive.copy(obj.userData.originalEmissive);
    else if (obj.material.emissive)
      obj.material.emissive.set(0x000000);
  }
}

function clearAllSelections() {
  multiSelected.forEach(o => removeHighlight(o));
  multiSelected.clear();
  const s = objManager.getSelected();
  if (s) objManager.selectObject(null);
}

function boxSelectObjects(x0, y0, x1, y1) {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const found = [];
  objManager.getObjects().forEach(obj => {
    const pos = new THREE.Vector3();
    obj.getWorldPosition(pos);
    pos.project(camera);
    const sx = ( pos.x + 1) / 2 * window.innerWidth;
    const sy = (-pos.y + 1) / 2 * window.innerHeight;
    if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) found.push(obj);
  });
  return found;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (transformControl.dragging) return;
  if (currentMode === 'mesh') return;
  lmbDown   = true;
  lmbStartX = e.clientX;
  lmbStartY = e.clientY;
  isDraggingBox = false;
});

window.addEventListener('pointermove', (e) => {
  if (!lmbDown) return;
  if (transformControl.dragging) { lmbDown = false; return; }
  const dx = e.clientX - lmbStartX;
  const dy = e.clientY - lmbStartY;
  if (!isDraggingBox && Math.sqrt(dx*dx + dy*dy) > BOX_THRESHOLD) {
    isDraggingBox = true;
    boxEl.style.display = 'block';
  }
  if (isDraggingBox) {
    boxEl.style.left   = Math.min(lmbStartX, e.clientX) + 'px';
    boxEl.style.top    = Math.min(lmbStartY, e.clientY) + 'px';
    boxEl.style.width  = Math.abs(dx) + 'px';
    boxEl.style.height = Math.abs(dy) + 'px';
  }
});

window.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !lmbDown) return;
  lmbDown = false;
  if (transformControl.dragging) return;

  if (isDraggingBox) {
    isDraggingBox = false;
    boxEl.style.display = 'none';
    if (currentMode === 'mesh') return;
    const found = boxSelectObjects(lmbStartX, lmbStartY, e.clientX, e.clientY);
    if (!e.shiftKey) clearAllSelections();
    if (found.length > 0) {
      const primary = found[found.length - 1];
      found.forEach(obj => { multiSelected.add(obj); applyHighlight(obj); });
      objManager.selectObject(primary);
      if (currentTool !== 'select') { transformControl.attach(primary); transformControl.setMode(currentTool); }
    } else {
      if (!e.shiftKey) { objManager.selectObject(null); transformControl.detach(); }
    }
    updateUI();
    return;
  }

  if (currentMode === 'mesh') return;
  const hit = raycastAt(e.clientX, e.clientY);

  if (e.shiftKey) {
    if (hit) {
      if (multiSelected.has(hit)) {
        multiSelected.delete(hit);
        removeHighlight(hit);
        const remaining = [...multiSelected];
        const newPrimary = remaining[remaining.length - 1] || null;
        objManager.selectObject(newPrimary);
        if (newPrimary && currentTool !== 'select') { transformControl.attach(newPrimary); transformControl.setMode(currentTool); }
        else transformControl.detach();
      } else {
        multiSelected.add(hit);
        applyHighlight(hit);
        objManager.selectObject(hit);
        if (currentTool !== 'select') { transformControl.attach(hit); transformControl.setMode(currentTool); }
      }
    }
  } else {
    clearAllSelections();
    if (hit) {
      objManager.selectObject(hit);
      if (currentTool !== 'select') { transformControl.attach(hit); transformControl.setMode(currentTool); }
    } else {
      objManager.selectObject(null);
      transformControl.detach();
    }
  }

  updateUI();
});

// ── History handlers ──
const historyHandlers = {
  onAdd(mesh) {
    scene.add(mesh);
    if (!objManager.objects.includes(mesh)) objManager.objects.push(mesh);
    updateUI();
  },
  onDelete(mesh) {
    objManager.deleteObject(mesh);
    if (transformControl.object === mesh) transformControl.detach();
    updateUI();
  },
  onTransform(mesh, state) {
    mesh.position.copy(state.pos);
    mesh.rotation.copy(state.rot);
    mesh.scale.copy(state.scale);
    updateUI();
  },
  onMeshEdit(mesh, snap) {
    // If we're currently in mesh mode editing this mesh, restore via MeshData
    if (currentMode === 'mesh' && meshEditor._data?.mesh === mesh) {
      meshEditor._data.restoreSnap(snap);
      meshEditor._renderer.update(meshEditor._data);
      meshEditor._updateGizmo();
    } else {
      // Restore geometry buffer directly (not in mesh edit mode)
      const pos = mesh.geometry.attributes.position;
      pos.array.set(snap);
      pos.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }
    updateUI();
  },
  afterAction() { updateUI(); },
};

// ── Keyboard ──
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    appHistory.undo(historyHandlers);
    return;
  }

  if (e.ctrlKey && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    appHistory.redo(historyHandlers);
    return;
  }

  if (e.shiftKey && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault();
    addMenu.style.left      = '50%';
    addMenu.style.top       = '50%';
    addMenu.style.transform = 'translate(-50%, -50%)';
    addMenu.classList.add('visible');
    return;
  }

  if (!e.ctrlKey) {
    if (e.key === 'w' || e.key === 'W') setTool('translate');
    if (e.key === 'r' || e.key === 'R') setTool('rotate');
    if (e.key === 's' || e.key === 'S') setTool('scale');
  }

  if (e.shiftKey && (e.key === 'd' || e.key === 'D')) {
    e.preventDefault();
    const sel = objManager.getSelected();
    if (sel) {
      const dupe = objManager.duplicateObject(sel);
      appHistory.push({ type: 'add', mesh: dupe });
      if (currentTool !== 'select') { transformControl.attach(dupe); transformControl.setMode(currentTool); }
      updateUI();
    }
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (currentMode === 'mesh') return;
    const sel = objManager.getSelected();
    if (sel) {
      appHistory.push({ type: 'delete', mesh: sel });
      multiSelected.delete(sel);
      objManager.deleteSelected();
      transformControl.detach();
      updateUI();
    }
  }

  if (e.key === 'Escape') {
    addMenu.classList.remove('visible');
    hideContextMenu();
  }
});

// ── Add menu ──
document.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', (e) => {
    const newMesh = objManager.addObject(e.currentTarget.dataset.type);
    appHistory.push({ type: 'add', mesh: newMesh });
    if (currentTool !== 'select') { transformControl.attach(newMesh); transformControl.setMode(currentTool); }
    addMenu.classList.remove('visible');
    updateUI();
  });
});

window.addEventListener('click', (e) => {
  if (addMenu.classList.contains('visible') && !e.target.closest('#add-menu') && !e.shiftKey)
    addMenu.classList.remove('visible');
});

// ════════════════════════════════════════════════
// EXPORT MENU
// ════════════════════════════════════════════════
const exportMenu  = document.getElementById('export-menu');
const btnExport   = document.getElementById('btn-export');
let   exportScope = 'scene';

function showExportMenu() {
  const rect = btnExport.getBoundingClientRect();
  exportMenu.style.left = (rect.right + 8) + 'px';
  exportMenu.style.top  = rect.top + 'px';
  exportMenu.classList.add('visible');
}
function hideExportMenu() { exportMenu.classList.remove('visible'); }

btnExport.addEventListener('click', (e) => {
  e.stopPropagation();
  exportMenu.classList.contains('visible') ? hideExportMenu() : showExportMenu();
});

document.getElementById('scope-scene').addEventListener('click', () => {
  exportScope = 'scene';
  document.getElementById('scope-scene').classList.add('active');
  document.getElementById('scope-selected').classList.remove('active');
});
document.getElementById('scope-selected').addEventListener('click', () => {
  exportScope = 'selected';
  document.getElementById('scope-selected').classList.add('active');
  document.getElementById('scope-scene').classList.remove('active');
});

exportMenu.querySelectorAll('.menu-item[data-fmt]').forEach(item => {
  item.addEventListener('click', () => {
    const fmt = item.dataset.fmt;
    if (exportScope === 'selected') {
      const sel = objManager.getSelected();
      if (!sel) {
        const el = document.createElement('div');
        el.className = 'export-toast';
        el.style.borderColor = 'rgba(255,50,50,0.4)';
        el.style.color = '#f88';
        el.textContent = '✗ No object selected';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2500);
        return;
      }
      exportModel([sel], fmt, sel.userData.name);
    } else {
      exportModel(objManager.getObjects(), fmt, 'scene');
    }
    hideExportMenu();
  });
});

window.addEventListener('mousedown', (e) => {
  if (!exportMenu.contains(e.target) && e.target !== btnExport) hideExportMenu();
});

// ════════════════════════════════════════════════
// IMPORT
// ════════════════════════════════════════════════
const triggerImport = setupImporter(objManager, updateUI);
const btnImport = document.getElementById('btn-import');
if (btnImport) btnImport.addEventListener('click', () => triggerImport());

// ════════════════════════════════════════════════
// CONTEXT MENU
// ════════════════════════════════════════════════
const ctxMenu  = document.getElementById('context-menu');
const ctxTitle = document.getElementById('ctx-title');
let   ctxTarget = null;

function showContextMenu(x, y, obj) {
  ctxTarget = obj;
  ctxTitle.textContent = obj.userData.name;
  const menuW = 180, menuH = 130;
  ctxMenu.style.left = Math.min(x, window.innerWidth  - menuW) + 'px';
  ctxMenu.style.top  = Math.min(y, window.innerHeight - menuH) + 'px';
  ctxMenu.classList.add('visible');
}

function hideContextMenu() {
  ctxMenu.classList.remove('visible');
  ctxTarget = null;
}

document.getElementById('ctx-rename').addEventListener('click', () => {
  if (!ctxTarget) return;
  const target = ctxTarget;
  hideContextMenu();
  setTimeout(() => startInlineRename(target), 0);
});

document.getElementById('ctx-duplicate').addEventListener('click', () => {
  if (!ctxTarget) return;
  const dupe = objManager.duplicateObject(ctxTarget);
  appHistory.push({ type: 'add', mesh: dupe });
  if (currentTool !== 'select') { transformControl.attach(dupe); transformControl.setMode(currentTool); }
  hideContextMenu();
  updateUI();
});

document.getElementById('ctx-delete').addEventListener('click', () => {
  if (!ctxTarget) return;
  appHistory.push({ type: 'delete', mesh: ctxTarget });
  const wasSelected = objManager.getSelected() === ctxTarget;
  multiSelected.delete(ctxTarget);
  objManager.deleteObject(ctxTarget);
  if (wasSelected) transformControl.detach();
  hideContextMenu();
  updateUI();
});

window.addEventListener('mousedown', (e) => {
  if (!ctxMenu.contains(e.target)) hideContextMenu();
});

canvas.addEventListener('contextmenu', e => e.preventDefault());

renderer.domElement.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (currentMode === 'mesh') return;
  const hit = raycastAt(e.clientX, e.clientY);
  if (hit) {
    objManager.selectObject(hit);
    if (currentTool !== 'select') { transformControl.attach(hit); transformControl.setMode(currentTool); }
    updateUI();
    showContextMenu(e.clientX, e.clientY, hit);
  }
});

// ════════════════════════════════════════════════
// INLINE RENAME
// ════════════════════════════════════════════════
function showRenameError(msg, x, y) {
  document.querySelectorAll('.rename-error').forEach(el => el.remove());
  const el = document.createElement('div');
  el.className = 'rename-error';
  el.textContent = msg;
  el.style.left = x + 'px';
  el.style.top  = (y - 30) + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

function startInlineRename(obj) {
  if (!obj) return;
  const items = hListEl.querySelectorAll('.h-item');
  let targetDiv = null;
  items.forEach(div => { if (div._meshRef === obj) targetDiv = div; });
  if (!targetDiv) return;

  const rect  = targetDiv.getBoundingClientRect();
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = obj.userData.name;
  input.type  = 'text';
  input.maxLength = 48;

  const icon = targetDiv.querySelector('.ic').outerHTML;
  targetDiv.innerHTML = icon + ' ';
  targetDiv.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const err = objManager.renameObject(obj, input.value);
    if (err) { showRenameError(err, rect.left, rect.top); input.focus(); input.select(); return; }
    updateUI();
  }

  let committed = false;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter')  { e.preventDefault(); committed = true; commit(); }
    if (e.key === 'Escape') { committed = true; updateUI(); }
  });
  input.addEventListener('blur', () => {
    if (committed) return;
    committed = true;
    if (!input.value.trim() || input.value.trim() === obj.userData.name) updateUI();
    else commit();
  });
}

// ════════════════════════════════════════════════
// HIERARCHY UI
// ════════════════════════════════════════════════
function updateUI() {
  objCountEl.textContent = `Objects: ${objManager.getObjectCount()}`;
  const sel = objManager.getSelected();
  selInfoEl.textContent  = currentMode === 'mesh'
    ? `Mesh Edit: ${sel ? sel.userData.name : '—'}`
    : sel ? `Selected: ${sel.userData.name}` : 'Nothing selected';

  hListEl.innerHTML = '';
  objManager.getObjects().forEach(obj => {
    const div = document.createElement('div');
    div.className = 'h-item';
    div._meshRef = obj;
    if (sel === obj || multiSelected.has(obj)) div.classList.add('active');

    const iconMap = { sphere:'●', cylinder:'⬡', cone:'▲', torus:'◎', plane:'▬' };
    const baseName = obj.userData.name.replace(/\s*\(\d+\)$/, '');
    const icon = iconMap[baseName] || '■';

    div.innerHTML = `<span class="ic">${icon}</span> ${obj.userData.name}`;

    div.addEventListener('click', (e) => {
      if (e.shiftKey) {
        if (multiSelected.has(obj)) { multiSelected.delete(obj); removeHighlight(obj); }
        else { multiSelected.add(obj); applyHighlight(obj); }
        objManager.selectObject(obj);
      } else {
        clearAllSelections();
        objManager.selectObject(obj);
      }
      if (currentTool !== 'select') { transformControl.attach(obj); transformControl.setMode(currentTool); }
      updateUI();
    });

    div.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      objManager.selectObject(obj);
      if (currentTool !== 'select') { transformControl.attach(obj); transformControl.setMode(currentTool); }
      updateUI();
      showContextMenu(e.clientX, e.clientY, obj);
    });

    div.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineRename(obj);
    });

    hListEl.appendChild(div);
  });
}

// ── Resize ──
window.addEventListener('resize', () => handleResize(camera, renderer));

// ── Render loop ──
let lastTime = performance.now(), frames = 0;

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  frames++;
  if (now >= lastTime + 1000) {
    fpsEl.textContent = `${frames} fps`;
    frames = 0;
    lastTime = now;
  }

  camInfoEl.textContent = `CAM: [${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)}]`;

  orbit.update();
  if (viewHelper.animating) viewHelper.update(clock.getDelta());

  renderer.render(scene, camera);
  gizmoRenderer.clear();
  viewHelper.render(gizmoRenderer);
}

setTool('translate');
updateUI();
animate();

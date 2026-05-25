import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';

import { createScene, createCamera, createRenderer, createLights, createGrid } from './scene.js';
import { createControls, handleResize } from './controls.js';
import { ObjectManager } from './objects.js';
import { exportModel } from './export.js';

const canvas = document.getElementById('viewport');
const scene = createScene();
const camera = createCamera();
const renderer = createRenderer(canvas);
renderer.autoClear = false;

createLights(scene);
createGrid(scene);

const orbit = createControls(camera, canvas);
const objManager = new ObjectManager(scene);
const clock = new THREE.Clock();

const undoStack = [];
let dragStartState = null;

// ── Gizmo ──
const gizmoCanvas = document.getElementById('gizmo');
const gizmoRenderer = new THREE.WebGLRenderer({ canvas: gizmoCanvas, alpha: true, antialias: true });
gizmoRenderer.setSize(120, 120);
const viewHelper = new ViewHelper(camera, gizmoCanvas);
gizmoCanvas.addEventListener('pointerup',   e => { e.stopPropagation(); viewHelper.handleClick(e); });
gizmoCanvas.addEventListener('pointerdown', e => e.stopPropagation());

// ── Transform controls ──
const transformControl = new TransformControls(camera, renderer.domElement);
scene.add(transformControl);

transformControl.addEventListener('dragging-changed', (event) => {
  orbit.enabled = !event.value;
  const mesh = transformControl.object;
  if (!mesh) return;
  if (event.value) {
    dragStartState = { pos: mesh.position.clone(), rot: mesh.rotation.clone(), scale: mesh.scale.clone() };
  } else if (dragStartState) {
    undoStack.push({ type: 'transform', mesh, oldState: dragStartState });
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

// ── Raycasting (viewport click to select) ──
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let isPointerMoved = false;

renderer.domElement.addEventListener('pointerdown', () => { isPointerMoved = false; });
renderer.domElement.addEventListener('pointermove', () => { isPointerMoved = true;  });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return; // left click only
  if (isPointerMoved || transformControl.dragging) return;

  mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(objManager.getObjects());

  if (hits.length > 0) {
    const obj = hits[0].object;
    objManager.selectObject(obj);
    if (currentTool !== 'select') { transformControl.attach(obj); transformControl.setMode(currentTool); }
  } else {
    objManager.selectObject(null);
    transformControl.detach();
  }
  updateUI();
});

// ── Keyboard ──
window.addEventListener('keydown', (e) => {
  console.log(e.key, e.shiftKey);
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
    const action = undoStack.pop();
    if (action) {
      if (action.type === 'add') {
        objManager.deleteObject(action.mesh);
        transformControl.detach();
      } else if (action.type === 'delete') {
        scene.add(action.mesh);
        objManager.objects.push(action.mesh);
      } else if (action.type === 'transform') {
        action.mesh.position.copy(action.oldState.pos);
        action.mesh.rotation.copy(action.oldState.rot);
        action.mesh.scale.copy(action.oldState.scale);
      }
      updateUI();
    }
    return;
  }

  if (e.shiftKey && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault();
    addMenu.style.left = '50%';
    addMenu.style.top  = '50%';
    addMenu.style.transform = 'translate(-50%, -50%)';
    addMenu.classList.add('visible');
    return;
  }

  if (!e.ctrlKey) {
    if (e.key === 'w' || e.key === 'G') setTool('translate');
    if (e.key === 'r' || e.key === 'R') setTool('rotate');
    if (e.key === 's' || e.key === 'S') setTool('scale');
  }

  // Shift+D to duplicate (like Blender) — plain D conflicts with browser shortcuts
  if (e.shiftKey && (e.key === 'd' || e.key === 'D')) {
    e.preventDefault();
    const sel = objManager.getSelected();
    if (sel) {
      const dupe = objManager.duplicateObject(sel);
      undoStack.push({ type: 'add', mesh: dupe });
      if (currentTool !== 'select') { transformControl.attach(dupe); transformControl.setMode(currentTool); }
      updateUI();
    }
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    const sel = objManager.getSelected();
    if (sel) {
      undoStack.push({ type: 'delete', mesh: sel });
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
    undoStack.push({ type: 'add', mesh: newMesh });
    if (currentTool !== 'select') { transformControl.attach(newMesh); transformControl.setMode(currentTool); }
    addMenu.classList.remove('visible');
    updateUI();
  });
});

window.addEventListener('click', (e) => {
  if (addMenu.classList.contains('visible') && !e.target.closest('#add-menu') && !e.shiftKey) {
    addMenu.classList.remove('visible');
  }
});

// ════════════════════════════════════════════════
// EXPORT MENU
// ════════════════════════════════════════════════
const exportMenu   = document.getElementById('export-menu');
const btnExport    = document.getElementById('btn-export');
let   exportScope  = 'scene'; // 'scene' | 'selected'

function showExportMenu() {
  const rect = btnExport.getBoundingClientRect();
  // Position to the right of the toolbar button
  exportMenu.style.left = (rect.right + 8) + 'px';
  exportMenu.style.top  = rect.top + 'px';
  exportMenu.classList.add('visible');
}
function hideExportMenu() { exportMenu.classList.remove('visible'); }

btnExport.addEventListener('click', (e) => {
  e.stopPropagation();
  exportMenu.classList.contains('visible') ? hideExportMenu() : showExportMenu();
});

// Scope toggle buttons
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

// Format buttons — only inside export-menu
exportMenu.querySelectorAll('.menu-item[data-fmt]').forEach(item => {
  item.addEventListener('click', () => {
    const fmt = item.dataset.fmt;

    if (exportScope === 'selected') {
      const sel = objManager.getSelected();
      if (!sel) {
        // Show error toast and stay open
        document.querySelectorAll('.export-toast').forEach(e => e.remove());
        const el = document.createElement('div');
        el.className = 'export-toast';
        el.style.borderColor = 'rgba(255,50,50,0.4)';
        el.style.color = '#f88';
        el.textContent = '✗ No object selected';
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2500);
        return;
      }
      exportModel(sel, fmt, sel.userData.name);
    } else {
      exportModel(objManager._exportGroup(THREE), fmt, 'scene');
    }
    hideExportMenu();
  });
});

// Close on outside click
window.addEventListener('mousedown', (e) => {
  if (!exportMenu.contains(e.target) && e.target !== btnExport) hideExportMenu();
});
const ctxMenu    = document.getElementById('context-menu');
const ctxTitle   = document.getElementById('ctx-title');
let ctxTarget    = null; // the object the menu was opened for

function showContextMenu(x, y, obj) {
  ctxTarget = obj;
  ctxTitle.textContent = obj.userData.name;

  // Keep menu inside viewport
  const menuW = 180, menuH = 130;
  ctxMenu.style.left = Math.min(x, window.innerWidth  - menuW) + 'px';
  ctxMenu.style.top  = Math.min(y, window.innerHeight - menuH) + 'px';
  ctxMenu.classList.add('visible');
}

function hideContextMenu() {
  ctxMenu.classList.remove('visible');
  ctxTarget = null;
}

// Rename
document.getElementById('ctx-rename').addEventListener('click', () => {
  if (!ctxTarget) return;
  const target = ctxTarget; // capture before hideContextMenu nulls it
  hideContextMenu();
  // setTimeout lets the menu DOM removal finish before we inject the input
  setTimeout(() => startInlineRename(target), 0);
});

// Duplicate
document.getElementById('ctx-duplicate').addEventListener('click', () => {
  if (!ctxTarget) return;
  const dupe = objManager.duplicateObject(ctxTarget);
  undoStack.push({ type: 'add', mesh: dupe });
  if (currentTool !== 'select') { transformControl.attach(dupe); transformControl.setMode(currentTool); }
  hideContextMenu();
  updateUI();
});

// Delete
document.getElementById('ctx-delete').addEventListener('click', () => {
  if (!ctxTarget) return;
  undoStack.push({ type: 'delete', mesh: ctxTarget });
  const wasSelected = objManager.getSelected() === ctxTarget;
  objManager.deleteObject(ctxTarget);
  if (wasSelected) transformControl.detach();
  hideContextMenu();
  updateUI();
});

// Close context menu on outside click
window.addEventListener('mousedown', (e) => {
  if (!ctxMenu.contains(e.target)) hideContextMenu();
});

// Prevent browser's native context menu on canvas
canvas.addEventListener('contextmenu', e => e.preventDefault());

// ════════════════════════════════════════════════
// INLINE RENAME (double-click or via context menu)
// ════════════════════════════════════════════════
function showRenameError(msg, x, y) {
  // Remove any existing error
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
  // Find the h-item div by its stored _meshRef (set during updateUI)
  const items = hListEl.querySelectorAll('.h-item');
  let targetDiv = null;
  items.forEach(div => { if (div._meshRef === obj) targetDiv = div; });
  if (!targetDiv) return;

  const rect = targetDiv.getBoundingClientRect();
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = obj.userData.name;
  input.type  = 'text';
  input.maxLength = 48;

  // Replace div content with input (keep icon)
  const icon = targetDiv.querySelector('.ic').outerHTML;
  targetDiv.innerHTML = icon + ' ';
  targetDiv.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const err = objManager.renameObject(obj, input.value);
    if (err) {
      showRenameError(err, rect.left, rect.top);
      input.focus();
      input.select();
      return;
    }
    updateUI();
  }

  let committed = false;

  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // don't fire G/R/S shortcuts while typing
    if (e.key === 'Enter')  { e.preventDefault(); committed = true; commit(); }
    if (e.key === 'Escape') { committed = true; updateUI(); } // cancel
  });

  input.addEventListener('blur', () => {
    if (committed) return; // already handled by keydown
    committed = true;
    // Blank or unchanged = cancel silently
    if (!input.value.trim() || input.value.trim() === obj.userData.name) {
      updateUI();
    } else {
      commit();
    }
  });
}

// ════════════════════════════════════════════════
// HIERARCHY UI
// ════════════════════════════════════════════════
function updateUI() {
  objCountEl.textContent = `Objects: ${objManager.getObjectCount()}`;
  const sel = objManager.getSelected();
  selInfoEl.textContent  = sel ? `Selected: ${sel.userData.name}` : 'Nothing selected';

  hListEl.innerHTML = '';
  objManager.getObjects().forEach(obj => {
    const div = document.createElement('div');
    div.className = 'h-item';
    div._meshRef = obj; // direct reference, used by startInlineRename
    if (sel === obj) div.classList.add('active');

    const iconMap = { sphere:'●', cylinder:'⬡', cone:'▲', torus:'◎', plane:'▬' };
    const baseName = obj.userData.name.replace(/\s*\(\d+\)$/, '');
    const icon = iconMap[baseName] || '■';

    div.innerHTML = `<span class="ic">${icon}</span> ${obj.userData.name}`;

    // Left-click: select
    div.addEventListener('click', (e) => {
      objManager.selectObject(obj);
      if (currentTool !== 'select') { transformControl.attach(obj); transformControl.setMode(currentTool); }
      updateUI();
    });

    // Right-click on hierarchy item: context menu
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      objManager.selectObject(obj);
      if (currentTool !== 'select') { transformControl.attach(obj); transformControl.setMode(currentTool); }
      updateUI();
      showContextMenu(e.clientX, e.clientY, obj);
    });

    // Double-click: inline rename
    div.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineRename(obj);
    });

    hListEl.appendChild(div);
  });
}

// Right-click on viewport objects also opens context menu
renderer.domElement.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(objManager.getObjects());
  if (hits.length > 0) {
    const obj = hits[0].object;
    objManager.selectObject(obj);
    if (currentTool !== 'select') { transformControl.attach(obj); transformControl.setMode(currentTool); }
    updateUI();
    showContextMenu(e.clientX, e.clientY, obj);
  }
});

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

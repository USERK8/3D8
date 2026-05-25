import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

import { createScene, createCamera, createRenderer, createLights, createGrid } from './scene.js';
import { createControls, handleResize } from './controls.js';
import { ObjectManager } from './objects.js';

// --- INITIALIZATION ---
const canvas = document.getElementById('viewport');
const scene = createScene();
const camera = createCamera();
const renderer = createRenderer(canvas);

createLights(scene);
createGrid(scene);

const orbit = createControls(camera, canvas);
const objManager = new ObjectManager(scene);

// --- UNDO STACK ---
const undoStack = [];
let dragStartState = null;

// --- TRANSFORM CONTROLS (The Gizmo) ---
const transformControl = new TransformControls(camera, renderer.domElement);
scene.add(transformControl);

transformControl.addEventListener('dragging-changed', (event) => {
  orbit.enabled = !event.value;
  
  const mesh = transformControl.object;
  if (!mesh) return;

  if (event.value) {
    // Drag started: Save the initial state before modifying
    dragStartState = {
      pos: mesh.position.clone(),
      rot: mesh.rotation.clone(),
      scale: mesh.scale.clone()
    };
  } else {
    // Drag ended: Push the transform action to the undo stack
    if (dragStartState) {
      undoStack.push({
        type: 'transform',
        mesh: mesh,
        oldState: dragStartState
      });
      dragStartState = null;
    }
  }
});

// --- UI ELEMENTS ---
const objCountEl = document.getElementById('obj-count');
const selInfoEl = document.getElementById('sel-info');
const fpsEl = document.getElementById('fps');
const camInfoEl = document.getElementById('cam-info');
const addMenu = document.getElementById('add-menu');
const toolBtns = document.querySelectorAll('.tool-btn');

// FIXED: Default to 'translate' so the gizmo shows up immediately
let currentTool = 'translate'; 

function setTool(toolName) {
  currentTool = toolName;
  
  toolBtns.forEach(btn => btn.classList.remove('active'));
  document.getElementById(toolName === 'select' ? 'btn-select' : `btn-${toolName === 'translate' ? 'move' : toolName}`).classList.add('active');

  const selectedObj = objManager.getSelected();
  if (toolName === 'select') {
    transformControl.detach();
  } else if (selectedObj) {
    transformControl.attach(selectedObj);
    transformControl.setMode(toolName); 
  }
}

// Bind UI Buttons
document.getElementById('btn-select').onclick = () => setTool('select');
document.getElementById('btn-move').onclick = () => setTool('translate');
document.getElementById('btn-rotate').onclick = () => setTool('rotate');
document.getElementById('btn-scale').onclick = () => setTool('scale');

// --- RAYCASTING (Object Selection) ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let isOrbiting = false;

renderer.domElement.addEventListener('pointerdown', () => { isOrbiting = false; });
renderer.domElement.addEventListener('pointermove', () => { isOrbiting = true; });

renderer.domElement.addEventListener('pointerup', (event) => {
  if (isOrbiting || transformControl.dragging) return; 

  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(objManager.getObjects());

  if (intersects.length > 0) {
    const clickedObj = intersects[0].object;
    objManager.selectObject(clickedObj);
    if (currentTool !== 'select') transformControl.attach(clickedObj);
  } else {
    objManager.selectObject(null);
    transformControl.detach();
  }
  updateUI();
});

// --- KEYBOARD SHORTCUTS ---
window.addEventListener('keydown', (event) => {
  // Undo (Ctrl + Z)
  if (event.ctrlKey && (event.key === 'z' || event.key === 'Z')) {
    const action = undoStack.pop();
    if (action) {
      if (action.type === 'add') {
        scene.remove(action.mesh);
        objManager.objects = objManager.objects.filter(o => o !== action.mesh);
        if (objManager.getSelected() === action.mesh) {
          objManager.selectObject(null);
          transformControl.detach();
        }
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

  // Add Menu (Shift + A)
  if (event.shiftKey && (event.key === 'a' || event.key === 'A')) {
    event.preventDefault();
    addMenu.classList.add('visible');
    addMenu.style.left = '50%';
    addMenu.style.top = '50%';
    addMenu.style.transform = 'translate(-50%, -50%)';
    return;
  }

  // Tools
  if (!event.ctrlKey) {
    if (event.key === 'g' || event.key === 'G') setTool('translate');
    if (event.key === 'r' || event.key === 'R') setTool('rotate');
    if (event.key === 's' || event.key === 'S') setTool('scale');
  }
  
  // Delete
  if (event.key === 'Delete' || event.key === 'Backspace') {
    const sel = objManager.getSelected();
    if (sel) {
      undoStack.push({ type: 'delete', mesh: sel }); // Save to undo stack
      objManager.deleteSelected();
      transformControl.detach();
      updateUI();
    }
  }

  if (event.key === 'Escape') addMenu.classList.remove('visible');
});

// --- ADD MENU LOGIC ---
document.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', (event) => {
    const type = event.currentTarget.dataset.type;
    const newMesh = objManager.addObject(type);
    
    undoStack.push({ type: 'add', mesh: newMesh }); // Save to undo stack
    
    if (currentTool !== 'select') transformControl.attach(newMesh);
    addMenu.classList.remove('visible');
    updateUI();
  });
});

window.addEventListener('click', (event) => {
  if (addMenu.classList.contains('visible') && !event.target.closest('#add-menu') && !event.shiftKey) {
    addMenu.classList.remove('visible');
  }
});

// --- WINDOW RESIZE ---
window.addEventListener('resize', () => handleResize(camera, renderer));

// --- UI UPDATER ---
function updateUI() {
  objCountEl.textContent = `Objects: ${objManager.getObjectCount()}`;
  const sel = objManager.getSelected();
  selInfoEl.textContent = sel ? `Selected: ${sel.userData.name}` : 'Nothing selected';
}

// --- ANIMATION LOOP ---
let lastTime = performance.now();
let frames = 0;

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
  renderer.render(scene, camera);
}

// Start the app
setTool('translate'); // Ensure UI syncs up on load
updateUI();
animate();

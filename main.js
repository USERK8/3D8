import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js'; 

import { createScene, createCamera, createRenderer, createLights, createGrid } from './scene.js';
import { createControls, handleResize } from './controls.js';
import { ObjectManager } from './objects.js';

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

// --- GIZMO SETUP ---
const gizmoCanvas = document.getElementById('gizmo');
const gizmoRenderer = new THREE.WebGLRenderer({ canvas: gizmoCanvas, alpha: true, antialias: true });
gizmoRenderer.setSize(120, 120);

const viewHelper = new ViewHelper(camera, gizmoCanvas);

gizmoCanvas.addEventListener('pointerup', (e) => {
  e.stopPropagation();
  viewHelper.handleClick(e);
});
gizmoCanvas.addEventListener('pointerdown', (e) => e.stopPropagation());

// --- TRANSFORM CONTROLS ---
const transformControl = new TransformControls(camera, renderer.domElement);
scene.add(transformControl);

transformControl.addEventListener('dragging-changed', (event) => {
  orbit.enabled = !event.value;
  const mesh = transformControl.object;
  if (!mesh) return;

  if (event.value) {
    dragStartState = { pos: mesh.position.clone(), rot: mesh.rotation.clone(), scale: mesh.scale.clone() };
  } else if (dragStartState) {
    undoStack.push({ type: 'transform', mesh: mesh, oldState: dragStartState });
    dragStartState = null;
  }
});

// --- UI ELEMENTS ---
const objCountEl = document.getElementById('obj-count');
const selInfoEl = document.getElementById('sel-info');
const fpsEl = document.getElementById('fps');
const camInfoEl = document.getElementById('cam-info');
const addMenu = document.getElementById('add-menu');
const toolBtns = document.querySelectorAll('.tool-btn');
const hListEl = document.getElementById('h-list');

let currentTool = 'translate'; 

function setTool(toolName) {
  currentTool = toolName;
  toolBtns.forEach(btn => btn.classList.remove('active'));
  document.getElementById(toolName === 'select' ? 'btn-select' : `btn-${toolName === 'translate' ? 'move' : toolName}`).classList.add('active');

  const selectedObj = objManager.getSelected();
  if (toolName === 'select') transformControl.detach();
  else if (selectedObj) {
    transformControl.attach(selectedObj);
    transformControl.setMode(toolName); 
  }
}

document.getElementById('btn-select').onclick = () => setTool('select');
document.getElementById('btn-move').onclick = () => setTool('translate');
document.getElementById('btn-rotate').onclick = () => setTool('rotate');
document.getElementById('btn-scale').onclick = () => setTool('scale');

// --- RAYCASTING ---
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

  if (event.shiftKey && (event.key === 'a' || event.key === 'A')) {
    event.preventDefault();
    addMenu.classList.add('visible');
    addMenu.style.left = '50%';
    addMenu.style.top = '50%';
    addMenu.style.transform = 'translate(-50%, -50%)';
    return;
  }

  if (!event.ctrlKey) {
    if (event.key === 'g' || event.key === 'G') setTool('translate');
    if (event.key === 'r' || event.key === 'R') setTool('rotate');
    if (event.key === 's' || event.key === 'S') setTool('scale');
  }
  
  if (event.key === 'Delete' || event.key === 'Backspace') {
    const sel = objManager.getSelected();
    if (sel) {
      undoStack.push({ type: 'delete', mesh: sel }); 
      objManager.deleteSelected();
      transformControl.detach();
      updateUI();
    }
  }

  if (event.key === 'Escape') addMenu.classList.remove('visible');
});

// --- ADD MENU ---
document.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', (event) => {
    const type = event.currentTarget.dataset.type;
    const newMesh = objManager.addObject(type);
    
    undoStack.push({ type: 'add', mesh: newMesh }); 
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

window.addEventListener('resize', () => handleResize(camera, renderer));

// --- UI UPDATER (NOW INCLUDES HIERARCHY!) ---
function updateUI() {
  objCountEl.textContent = `Objects: ${objManager.getObjectCount()}`;
  const sel = objManager.getSelected();
  selInfoEl.textContent = sel ? `Selected: ${sel.userData.name}` : 'Nothing selected';

  // Rebuild the hierarchy list
  hListEl.innerHTML = '';
  objManager.getObjects().forEach(obj => {
    const div = document.createElement('div');
    div.className = 'h-item';
    if (sel === obj) div.classList.add('active');
    
    // Assign a matching icon
    let icon = '■';
    if (obj.userData.name.includes('sphere')) icon = '●';
    else if (obj.userData.name.includes('cylinder')) icon = '⬡';
    else if (obj.userData.name.includes('cone')) icon = '▲';
    else if (obj.userData.name.includes('torus')) icon = '◎';
    else if (obj.userData.name.includes('plane')) icon = '▬';

    div.innerHTML = `<span class="ic">${icon}</span> ${obj.userData.name}`;
    
    // Make the hierarchy clickable!
    div.onclick = () => {
      objManager.selectObject(obj);
      if (currentTool !== 'select') transformControl.attach(obj);
      updateUI();
    };
    
    hListEl.appendChild(div);
  });
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
  
  if (viewHelper.animating === true) {
    viewHelper.update(clock.getDelta());
  }

  renderer.render(scene, camera);
  gizmoRenderer.clear();
  viewHelper.render(gizmoRenderer);
}

// Start the app
setTool('translate'); 
updateUI();
animate();

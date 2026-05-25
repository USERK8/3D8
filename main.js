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

// --- GIZMO SETUP ---
const gizmoCanvas = document.getElementById('gizmo');
const viewLabelEl = document.getElementById('view-label');

const gizmoRenderer = new THREE.WebGLRenderer({ canvas: gizmoCanvas, alpha: true, antialias: true });
gizmoRenderer.setSize(90, 90);
const gizmoScene = new THREE.Scene();

// Orthographic camera for the gizmo so the axes don't warp
const gizmoCamera = new THREE.OrthographicCamera(-1.2, 1.2, 1.2, -1.2, 0.1, 10);
gizmoCamera.position.set(0, 0, 5);
gizmoCamera.up.set(0, 0, 1); 

// Create Blender-style Axis Lines
function createGizmoAxis(color, euler) {
  const group = new THREE.Group();
  const lineMat = new THREE.LineBasicMaterial({ color: color, linewidth: 3 });
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1, 0)
  ]);
  group.add(new THREE.Line(lineGeo, lineMat));
  
  const sphereMat = new THREE.MeshBasicMaterial({ color: color });
  const sphereGeo = new THREE.SphereGeometry(0.18, 16, 16);
  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  sphere.position.set(0, 1, 0);
  group.add(sphere);
  
  group.rotation.copy(euler);
  return group;
}

// X = Red, Y = Blue, Z = Green
gizmoScene.add(createGizmoAxis(0xff3333, new THREE.Euler(0, 0, -Math.PI/2))); 
gizmoScene.add(createGizmoAxis(0x4488ff, new THREE.Euler(0, 0, 0))); 
gizmoScene.add(createGizmoAxis(0x33aa44, new THREE.Euler(Math.PI/2, 0, 0))); 

function updateViewLabel() {
  const v = new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z).normalize();
  const rx = Math.round(v.x);
  const ry = Math.round(v.y);
  const rz = Math.round(v.z);

  if (rx === 0 && ry === 0 && rz === 1) viewLabelEl.textContent = 'TOP';
  else if (rx === 0 && ry === 0 && rz === -1) viewLabelEl.textContent = 'BOTTOM';
  else if (rx === 0 && ry === -1 && rz === 0) viewLabelEl.textContent = 'FRONT';
  else if (rx === 0 && ry === 1 && rz === 0) viewLabelEl.textContent = 'BACK';
  else if (rx === 1 && ry === 0 && rz === 0) viewLabelEl.textContent = 'RIGHT';
  else if (rx === -1 && ry === 0 && rz === 0) viewLabelEl.textContent = 'LEFT';
  else viewLabelEl.textContent = 'PERSP';
}

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
  if (now >= lastTime + 10

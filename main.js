import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// Import our custom modules
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

// --- TRANSFORM CONTROLS (The Gizmo) ---
const transformControl = new TransformControls(camera, renderer.domElement);
scene.add(transformControl);

// Disable orbit controls when we are dragging an object
transformControl.addEventListener('dragging-changed', (event) => {
  orbit.enabled = !event.value;
});

// --- UI ELEMENTS ---
const objCountEl = document.getElementById('obj-count');
const selInfoEl = document.getElementById('sel-info');
const fpsEl = document.getElementById('fps');
const camInfoEl = document.getElementById('cam-info');
const addMenu = document.getElementById('add-menu');
const toolBtns = document.querySelectorAll('.tool-btn');

let currentTool = 'select';

// --- TOOL SELECTION LOGIC ---
function setTool(toolName) {
  currentTool = toolName;
  
  // Update UI Buttons
  toolBtns.forEach(btn => btn.classList.remove('active'));
  document.getElementById(`btn-${toolName}`).classList.add('active');

  // Update Gizmo
  const selectedObj = objManager.getSelected();
  if (toolName === 'select') {
    transformControl.detach();
  } else {
    if (selectedObj) {
      transformControl.attach(selectedObj);
      transformControl.setMode(toolName); // 'translate', 'rotate', or 'scale'
    }
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

// Prevent selecting objects if we are just panning/orbiting the camera
renderer.domElement.addEventListener('pointerdown', () => { isOrbiting = false; });
renderer.domElement.addEventListener('pointermove', () => { isOrbiting = true; });

renderer.domElement.addEventListener('pointerup', (event) => {
  if (isOrbiting || transformControl.dragging) return; // Don't select if dragging camera or gizmo

  // Calculate mouse position in normalized device coordinates (-1 to +1)
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  // Check intersections with our managed objects
  const intersects = raycaster.intersectObjects(objManager.getObjects());

  if (intersects.length > 0) {
    const clickedObj = intersects[0].object;
    objManager.selectObject(clickedObj);
    
    // Attach gizmo if we aren't in 'select-only' mode
    if (currentTool !== 'select') {
      transformControl.attach(clickedObj);
    }
  } else {
    // Clicked empty space
    objManager.selectObject(null);
    transformControl.detach();
  }
  updateUI();
});

// --- KEYBOARD SHORTCUTS ---
window.addEventListener('keydown', (event) => {
  // Add Menu (Shift + A)
  if (event.shiftKey && (event.key === 'a' || event.key === 'A')) {
    event.preventDefault();
    addMenu.classList.add('visible');
    // Position menu at mouse cursor logic could go here, for now it centers via CSS
    addMenu.style.left = '50%';
    addMenu.style.top = '50%';
    addMenu.style.transform = 'translate(-50%, -50%)';
    return;
  }

  // Tools
  if (event.key === 'g' || event.key === 'G') setTool('translate');
  if (event.key === 'r' || event.key === 'R') setTool('rotate');
  if (event.key === 's' || event.key === 'S') setTool('scale');
  
  // Delete
  if (event.key === 'Delete' || event.key === 'Backspace') {
    objManager.deleteSelected();
    transformControl.detach();
    updateUI();
  }

  // Close menu on Escape
  if (event.key === 'Escape') {
    addMenu.classList.remove('visible');
  }
});

// --- ADD MENU LOGIC ---
document.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', (event) => {
    const type = event.currentTarget.dataset.type;
    const newMesh = objManager.addObject(type);
    
    // Auto-select and attach gizmo
    if (currentTool !== 'select') {
      transformControl.attach(newMesh);
    }
    
    addMenu.classList.remove('visible');
    updateUI();
  });
});

// Hide add menu if clicked outside
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

  // FPS Counter
  const now = performance.now();
  frames++;
  if (now >= lastTime + 1000) {
    fpsEl.textContent = `${frames} fps`;
    frames = 0;
    lastTime = now;
  }

  // Update Camera Info
  camInfoEl.textContent = `CAM: [${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)}]`;

  orbit.update(); // required if damping enabled
  renderer.render(scene, camera);
}

// Start the app
updateUI();
animate();

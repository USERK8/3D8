import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  
  // Smooth, responsive controls
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  
  // Distance limits
  controls.minDistance = 0.3;
  controls.maxDistance = 800;
  
  // Mouse button mapping
  controls.mouseButtons = {
    LEFT: 0,    // ROTATE
    MIDDLE: 1,  // DOLLY (zoom)
    RIGHT: 2    // PAN
  };
  
  // FIXED: Smooth zoom with smaller steps
  // This prevents the "one giant jump" issue
  controls.zoomSpeed = 0.5; // Slower, more controlled zoom
  
  // Prevent zoom from being too sensitive
  controls.enableZoom = true;
  
  return controls;
}

export function handleResize(camera, renderer) {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

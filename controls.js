import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  // Smooth, responsive controls
  controls.enableDamping = true;
  controls.dampingFactor = 0.05; // Blender-like smoothness
  controls.screenSpacePanning = true; 
  
  // THE ZOOM FIX 2.0
  // Tanking this multiplier to handle high-resolution scroll wheels/trackpads.
  // If it is STILL too fast, change this to 0.005 or 0.001!
  controls.zoomSpeed = 0.01; 
  
  // Hard limits
  controls.minDistance = 0.5; 
  controls.maxDistance = 150; 
  
  // Mouse button mapping
  controls.mouseButtons = {
    LEFT: 0,    // ROTATE
    MIDDLE: 1,  // DOLLY (zoom)
    RIGHT: 2    // PAN
  };
  
  return controls;
}

export function handleResize(camera, renderer) {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

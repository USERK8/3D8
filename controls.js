import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  // Smooth, responsive controls
  controls.enableDamping = true;
  controls.dampingFactor = 0.05; // Blender-like smoothness
  controls.screenSpacePanning = true; 
  
  // FIXED: Stop the infinite zoom glitch!
  controls.enableZoom = true;
  controls.zoomSpeed = 1.0;
  
  // This stops the camera from clipping through the 0,0,0 origin and flipping out
  controls.minDistance = 1.0; 
  // This stops you from zooming out into the infinite void
  controls.maxDistance = 500; 
  
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

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  // Smooth, responsive controls
  controls.enableDamping = true;
  controls.dampingFactor = 0.05; 
  controls.screenSpacePanning = true; 
  
  // FIXED: Disable the buggy native zoom entirely
  controls.enableZoom = false; 
  
  // Distance limits
  controls.minDistance = 0.5; 
  controls.maxDistance = 150; 
  
  controls.mouseButtons = {
    LEFT: 0,    // ROTATE
    MIDDLE: 1,  // DOLLY (zoom)
    RIGHT: 2    // PAN
  };
  
  // --- CUSTOM BLENDER-STYLE ZOOM ---
  // This physically moves the camera by exactly 10% per tick, 
  // bypassing any crazy browser scroll multipliers.
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault(); 
    
    const zoomSensitivity = 0.1; // 10% zoom step (just like Blender)
    const distance = camera.position.distanceTo(controls.target);
    
    // Calculate new distance based on scroll direction
    let newDistance = event.deltaY > 0 
        ? distance * (1 + zoomSensitivity) 
        : distance * (1 - zoomSensitivity);
        
    // Clamp it strictly to our limits
    newDistance = Math.max(controls.minDistance, Math.min(controls.maxDistance, newDistance));
    
    // Move camera along the invisible line between the target and its current position
    const direction = camera.position.clone().sub(controls.target).normalize();
    camera.position.copy(controls.target).add(direction.multiplyScalar(newDistance));
    
    controls.update(); 
    camera.updateProjectionMatrix();
  }, { passive: false });
  
  return controls;
}

export function handleResize(camera, renderer) {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

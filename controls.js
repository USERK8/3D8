import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  // Smooth, responsive controls
  controls.enableDamping = true;
  controls.dampingFactor = 0.05; 
  controls.screenSpacePanning = true; 
  
  // Disable native zoom entirely to stop conflicts
  controls.enableZoom = false; 
  
  // Distance limits
  controls.minDistance = 0.5; 
  controls.maxDistance = 150; 
  
  // FIXED: Middle button does absolutely nothing now.
  controls.mouseButtons = {
    LEFT: 0,   // Left click -> Rotate
    RIGHT: 2   // Right click -> Pan
    // MIDDLE is intentionally left out so it does nothing
  };
  
  // --- BULLETPROOF BLENDER ZOOM ---
  let lastZoomTime = 0;
  
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault(); 
    
    // The 100ms Cooldown Throttle 
    // (This stops the Acer mouse from sending multiple scroll chunks at once)
    const now = performance.now();
    if (now - lastZoomTime < 100) return; 
    lastZoomTime = now;
    
    const zoomSensitivity = 0.15; // 15% zoom step per scroll tick
    const distance = camera.position.distanceTo(controls.target);
    
    // Prevent math from breaking if distance hits exactly 0
    if (distance < 0.001) {
        camera.position.z += 0.1;
    }
    
    // Calculate new distance based on scroll direction
    let newDistance = event.deltaY > 0 
        ? distance * (1 + zoomSensitivity) 
        : distance * (1 - zoomSensitivity);
        
    // Clamp it to our limits
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

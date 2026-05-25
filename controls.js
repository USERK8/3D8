import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  controls.enableDamping    = true;
  controls.dampingFactor    = 0.05;
  controls.screenSpacePanning = true;
  controls.enableZoom       = false;
  controls.minDistance      = 0.5;
  controls.maxDistance      = 150;

  controls.mouseButtons = {
    LEFT:   0, // Rotate
    MIDDLE: 2  // Pan (like Blender)
  };

  // Flat symmetric zoom:
  // every scroll tick multiplies OR divides by the same constant.
  // dividing on zoom-in and multiplying on zoom-out means both
  // directions move by exactly the same percentage — no asymmetry.
  const ZOOM_FACTOR = 1.1; // 10% per tick

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();

    const distance = camera.position.distanceTo(controls.target);
    if (distance < 0.001) camera.position.z += 0.1;

    const zoomIn = event.deltaY < 0;
    let newDistance = zoomIn ? distance / ZOOM_FACTOR : distance * ZOOM_FACTOR;
    newDistance = Math.max(controls.minDistance, Math.min(controls.maxDistance, newDistance));

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

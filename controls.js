import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.screenSpacePanning = true;
  controls.enableZoom = false; // we handle zoom manually for better feel

  controls.minDistance = 0.5;
  controls.maxDistance = 150;

  controls.mouseButtons = {
    LEFT: 0,  // Rotate
    RIGHT: 2  // Pan
  };

  // Smooth zoom: no throttle, uses exponential step so it feels
  // consistent whether you're close or far from the target
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();

    const zoomSensitivity = 0.1;
    const distance = camera.position.distanceTo(controls.target);

    if (distance < 0.001) {
      camera.position.z += 0.1;
    }

    // deltaY can vary wildly between devices/browsers, so we
    // clamp the raw value first so one "hard scroll" can't
    // teleport the camera
    const rawDelta = Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 100);
    const factor   = 1 + rawDelta * zoomSensitivity * 0.01 * distance;
    let newDistance = distance * factor;
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

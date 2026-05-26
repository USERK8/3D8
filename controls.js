import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  controls.enableDamping      = true;
  controls.dampingFactor      = 0.05;
  controls.screenSpacePanning = true;
  controls.enableZoom         = false;

  // Move rotate from LMB to MMB, free LMB for selection
  // Shift+MMB = pan (OrbitControls does this natively when shiftKey is held)
  controls.mouseButtons = {
    LEFT:   -1,
    MIDDLE: THREE.MOUSE.ROTATE,
    RIGHT:  -1,
  };

  // No vertical rotation limit
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;

  // ── Scroll → Zoom (no limits) ──
  const ZOOM_FACTOR = 1.1;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();

    const distance = camera.position.distanceTo(controls.target);
    if (distance < 0.001) camera.position.z += 0.1;

    const zoomIn      = e.deltaY < 0;
    const newDistance = zoomIn ? distance / ZOOM_FACTOR : distance * ZOOM_FACTOR;

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

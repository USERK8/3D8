import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  controls.enableDamping      = true;
  controls.dampingFactor      = 0.05;
  controls.screenSpacePanning = true;
  controls.enableZoom         = false;

  // MMB = rotate (what LMB normally does in OrbitControls)
  // Shift+MMB = pan   (what MMB/RMB normally does)
  // LMB = nothing (freed up for selection in main.js)
  controls.mouseButtons = {
    MIDDLE: THREE.MOUSE.ROTATE,
  };

  // Shift+MMB → pan: OrbitControls handles this natively when
  // we set the pan button to MIDDLE and check e.shiftKey.
  // Easiest way: swap MIDDLE to PAN when Shift is held.
  canvas.addEventListener('mousedown', e => {
    if (e.button !== 1) return;
    if (e.shiftKey) {
      controls.mouseButtons = { MIDDLE: THREE.MOUSE.PAN };
    } else {
      controls.mouseButtons = { MIDDLE: THREE.MOUSE.ROTATE };
    }
  });

  // No polar angle limits — full rotation
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;

  // ── Scroll → Zoom (no distance limits) ──
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

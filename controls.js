import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  controls.enableDamping      = true;
  controls.dampingFactor      = 0.05;
  controls.screenSpacePanning = true;
  controls.enableZoom         = false;

  controls.mouseButtons = {
    MIDDLE: THREE.MOUSE.ROTATE,
  };

  canvas.addEventListener('mousedown', e => {
    if (e.button !== 1) return;
    if (e.shiftKey) {
      controls.mouseButtons = { MIDDLE: THREE.MOUSE.PAN };
    } else {
      controls.mouseButtons = { MIDDLE: THREE.MOUSE.ROTATE };
    }
  });

  // Invert rotation direction to feel natural (like Blender)
  controls.rotateSpeed = -1;

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

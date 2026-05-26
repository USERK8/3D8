import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';

export function createControls(camera, canvas) {
  const controls = new TrackballControls(camera, canvas);

  controls.rotateSpeed = 2.0;
  controls.zoomSpeed   = 0;
  controls.panSpeed    = 0.8;
  controls.noZoom      = true;
  controls.noPan       = true;
  controls.noRotate    = false;
  controls.staticMoving = false;
  controls.dynamicDampingFactor = 0.15;

  // LMB=nothing (freed for selection), MMB=rotate, Shift+MMB=pan
  controls.mouseButtons = {
    LEFT:   -1,
    MIDDLE: THREE.MOUSE.ROTATE,
    RIGHT:  -1,
  };

  canvas.addEventListener('mousedown', e => {
    if (e.button !== 1) return;
    if (e.shiftKey) {
      controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
      controls.noPan = false;
    } else {
      controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
      controls.noPan = true;
    }
  });

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

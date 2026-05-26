import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  controls.enableDamping      = true;
  controls.dampingFactor      = 0.05;
  controls.screenSpacePanning = true;
  controls.enableZoom         = false;
  controls.enableRotate       = false; // we drive rotation manually
  controls.enablePan          = false; // we drive pan manually
  controls.mouseButtons       = {};    // no button bindings for OrbitControls

  let isMMBDown   = false;
  let isShiftDown = false;
  let lastX = 0, lastY = 0;

  window.addEventListener('keydown', e => { if (e.key === 'Shift') isShiftDown = true;  });
  window.addEventListener('keyup',   e => { if (e.key === 'Shift') isShiftDown = false; });

  canvas.addEventListener('mousedown', e => {
    if (e.button !== 1) return;
    e.preventDefault();
    isMMBDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  window.addEventListener('mouseup', e => {
    if (e.button === 1) isMMBDown = false;
  });

  window.addEventListener('mousemove', e => {
    if (!isMMBDown) return;

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (isShiftDown) {
      // ── Shift+MMB → Pan ──
      const distance = camera.position.distanceTo(controls.target);
      const panSpeed  = distance * 0.001;

      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up    = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);

      controls.target.addScaledVector(right, -dx * panSpeed);
      controls.target.addScaledVector(up,     dy * panSpeed);
      camera.position.addScaledVector(right, -dx * panSpeed);
      camera.position.addScaledVector(up,     dy * panSpeed);

    } else {
      // ── MMB → Orbit ──
      // Horizontal drag: rotate around world Y (azimuth)
      // Vertical drag:   rotate around camera's local right axis (elevation)
      const SPEED = 0.005;

      const offset = camera.position.clone().sub(controls.target);

      // Horizontal: rotate offset around world Y
      if (dx !== 0) {
        const yawQ = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          dx * SPEED
        );
        offset.applyQuaternion(yawQ);
      }

      // Vertical: rotate offset around camera's right vector
      if (dy !== 0) {
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).normalize();
        const pitchQ = new THREE.Quaternion().setFromAxisAngle(
          right,
          dy * SPEED
        );
        offset.applyQuaternion(pitchQ);
      }

      // No polar clamp — unrestricted full rotation
      camera.position.copy(controls.target).add(offset);
      camera.lookAt(controls.target);
    }

    controls.update();
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

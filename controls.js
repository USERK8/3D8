import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  controls.enableDamping      = true;
  controls.dampingFactor      = 0.05;
  controls.screenSpacePanning = true;
  controls.enableZoom         = false;
  controls.enableRotate       = false;
  controls.enablePan          = false;
  controls.mouseButtons       = {};

  // ── Persistent spherical state (avoids re-deriving angles each frame) ──
  const spherical = new THREE.Spherical();
  // Initialise from wherever the camera currently sits
  function syncSphericalFromCamera() {
    const offset = camera.position.clone().sub(controls.target);
    spherical.setFromVector3(offset);
  }
  syncSphericalFromCamera();

  // ── State ──
  let isMMBDown   = false;
  let isShiftDown = false;
  let lastX = 0, lastY = 0;

  window.addEventListener('keydown', e => { if (e.key === 'Shift') isShiftDown = true;  });
  window.addEventListener('keyup',   e => { if (e.key === 'Shift') isShiftDown = false; });

  canvas.addEventListener('mousedown', e => {
    if (e.button !== 1) return;
    e.preventDefault();
    syncSphericalFromCamera(); // re-sync at the start of each drag
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

      const right = new THREE.Vector3();
      const up    = new THREE.Vector3();
      right.setFromMatrixColumn(camera.matrix, 0);
      up.setFromMatrixColumn(camera.matrix, 1);

      controls.target.addScaledVector(right, -dx * panSpeed);
      controls.target.addScaledVector(up,     dy * panSpeed);
      camera.position.addScaledVector(right, -dx * panSpeed);
      camera.position.addScaledVector(up,     dy * panSpeed);

      // After panning the target moved, re-sync so next rotate is correct
      syncSphericalFromCamera();
    } else {
      // ── MMB → Orbit (no polar clamp — full 360° on both axes) ──
      const rotateSpeed = 0.005;

      spherical.theta -= dx * rotateSpeed; // horizontal drag = azimuth
      spherical.phi   -= dy * rotateSpeed; // vertical drag   = polar

      // Wrap theta freely — no limit
      // Allow phi to go past poles (full rotation, no clamp)
      // Just keep radius sane
      spherical.radius = Math.max(0.001, spherical.radius);
      spherical.makeSafe(); // only fixes NaN/Infinity, doesn't clamp angles

      // Manually apply because makeSafe clamps phi to (EPS, PI-EPS);
      // we want unclamped so we write the offset directly:
      const sinPhi = Math.sin(spherical.phi);
      const cosPhi = Math.cos(spherical.phi);
      const offset = new THREE.Vector3(
        spherical.radius * sinPhi * Math.sin(spherical.theta),
        spherical.radius * cosPhi,
        spherical.radius * sinPhi * Math.cos(spherical.theta)
      );

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

    // Keep spherical radius in sync after zoom
    spherical.radius = newDistance;

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

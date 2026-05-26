import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createControls(camera, canvas) {
  const controls = new OrbitControls(camera, canvas);

  controls.enableDamping      = true;
  controls.dampingFactor      = 0.05;
  controls.screenSpacePanning = true;
  controls.enableZoom         = false; // we handle zoom manually
  controls.enableRotate       = false; // we handle MMB manually
  controls.enablePan          = false; // we handle Shift+MMB manually

  // No zoom limits — removed minDistance / maxDistance

  // Disable OrbitControls' own mouse button bindings entirely;
  // we drive everything ourselves below.
  controls.mouseButtons = {};

  // ── State ──
  let isMMBDown    = false;
  let isShiftDown  = false;
  let lastX = 0, lastY = 0;

  // Track Shift key globally
  window.addEventListener('keydown', e => { if (e.key === 'Shift') isShiftDown = true;  });
  window.addEventListener('keyup',   e => { if (e.key === 'Shift') isShiftDown = false; });

  // ── MMB press / release ──
  canvas.addEventListener('mousedown', e => {
    if (e.button !== 1) return; // middle button only
    e.preventDefault();
    isMMBDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  window.addEventListener('mouseup', e => {
    if (e.button === 1) isMMBDown = false;
  });

  // ── MMB drag → rotate OR pan ──
  window.addEventListener('mousemove', e => {
    if (!isMMBDown) return;

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (isShiftDown) {
      // ── Shift+MMB → Pan ──
      // Pan speed proportional to distance from target
      const distance = camera.position.distanceTo(controls.target);
      const panSpeed = distance * 0.001;

      // Build right & up vectors from camera
      const right = new (camera.position.constructor)();
      const up    = new (camera.position.constructor)();
      right.setFromMatrixColumn(camera.matrix, 0);
      up.setFromMatrixColumn(camera.matrix, 1);

      // Import THREE lazily via controls' internal camera reference
      // Use vector math directly on the target
      controls.target.addScaledVector(right, -dx * panSpeed);
      controls.target.addScaledVector(up,     dy * panSpeed);
      camera.position.addScaledVector(right, -dx * panSpeed);
      camera.position.addScaledVector(up,     dy * panSpeed);
    } else {
      // ── MMB → Orbit/Rotate ──
      const rotateSpeed = 0.005;
      // Horizontal drag → rotate around world Y
      const spherical = { theta: -dx * rotateSpeed, phi: -dy * rotateSpeed };

      // Offset from target
      const offset = camera.position.clone().sub(controls.target);
      const radius = offset.length();

      // Convert to spherical
      let theta = Math.atan2(offset.x, offset.z);
      let phi   = Math.acos(Math.min(Math.max(offset.y / radius, -1), 1));

      theta += spherical.theta;
      phi   += spherical.phi;

      // Clamp phi to avoid gimbal flip
      phi = Math.max(0.01, Math.min(Math.PI - 0.01, phi));

      offset.x = radius * Math.sin(phi) * Math.sin(theta);
      offset.y = radius * Math.cos(phi);
      offset.z = radius * Math.sin(phi) * Math.cos(theta);

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

    const zoomIn = e.deltaY < 0;
    const newDistance = zoomIn ? distance / ZOOM_FACTOR : distance * ZOOM_FACTOR;
    // No clamping — unlimited zoom

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

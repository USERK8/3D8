import * as THREE from 'three';

export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);
  return scene;
}

export function createCamera() {
  const camera = new THREE.PerspectiveCamera(
    60, 
    window.innerWidth / window.innerHeight, 
    0.1, 
    2000
  );
  camera.position.set(5, 7, 4);
  return camera;
}

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  return renderer;
}

export function createLights(scene) {
  // Ambient light
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  
  // Sun (main directional light)
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(8, 12, 6);
  sun.castShadow = true;
  scene.add(sun);
  
  // Soft fill from below
  const fill = new THREE.DirectionalLight(0x8899bb, 0.3);
  fill.position.set(-5, -3, -5);
  scene.add(fill);
}

export function createGrid(scene) {
  // Custom grid with colored axes
  // X-axis (red), Y-axis (blue), Z-axis neutral
  const size = 300;
  const divisions = 300;
  const gridHelper = new THREE.GridHelper(size, divisions, 0x3a3a3a, 0x242424);
  
  // Rotate grid to match our Y/Z swap (grid is on XY plane now, Z is up)
  gridHelper.rotation.x = Math.PI / 2;
  scene.add(gridHelper);
  
  // Add colored axis lines
  const axisLength = 150;
  
  // X-axis - RED
  const xAxisMaterial = new THREE.LineBasicMaterial({ color: 0xff0000 });
  const xAxisGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-axisLength, 0, 0),
    new THREE.Vector3(axisLength, 0, 0)
  ]);
  scene.add(new THREE.Line(xAxisGeometry, xAxisMaterial));
  
  // Y-axis - BLUE
  const yAxisMaterial = new THREE.LineBasicMaterial({ color: 0x4488ff });
  const yAxisGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, -axisLength, 0),
    new THREE.Vector3(0, axisLength, 0)
  ]);
  scene.add(new THREE.Line(yAxisGeometry, yAxisMaterial));
  
  // Z-axis - DARK GREEN (vertical)
  const zAxisMaterial = new THREE.LineBasicMaterial({ color: 0x33aa44 });
  const zAxisGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, -axisLength),
    new THREE.Vector3(0, 0, axisLength)
  ]);
  scene.add(new THREE.Line(zAxisGeometry, zAxisMaterial));
}

import * as THREE from 'three';

export function createScene() {
  const scene = new THREE.Scene();
  // FIXED: No background color! This lets the CSS gradient show through.
  return scene;
}

export function createCamera() {
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
  camera.up.set(0, 0, 1);
  camera.position.set(5, 5, 4); 
  return camera;
}

export function createRenderer(canvas) {
  // FIXED: alpha: true allows the canvas to be transparent
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0); // 0 opacity
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  return renderer;
}

export function createLights(scene) {
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(8, 12, 6);
  sun.castShadow = true;
  scene.add(sun);
  
  const fill = new THREE.DirectionalLight(0x8899bb, 0.3);
  fill.position.set(-5, -3, -5);
  scene.add(fill);
}

export function createGrid(scene) {
  const size = 300;
  const divisions = 300;
  
  // Subtle dark grid
  const gridHelper = new THREE.GridHelper(size, divisions, 0x444466, 0x222233);
  gridHelper.rotation.x = Math.PI / 2;
  gridHelper.material.transparent = true;
  gridHelper.material.opacity = 0.25;
  scene.add(gridHelper);
  
  // NEW: Futuristic Floating Neon Boundary Rings
  const outerRingGeo = new THREE.RingGeometry(4.8, 5, 64);
  const outerRingMat = new THREE.MeshBasicMaterial({ color: 0xaa55ff, side: THREE.DoubleSide, transparent: true, opacity: 0.3 });
  scene.add(new THREE.Mesh(outerRingGeo, outerRingMat));
  
  const innerRingGeo = new THREE.RingGeometry(1.9, 2, 64);
  const innerRingMat = new THREE.MeshBasicMaterial({ color: 0x55aaff, side: THREE.DoubleSide, transparent: true, opacity: 0.2 });
  scene.add(new THREE.Mesh(innerRingGeo, innerRingMat));
}

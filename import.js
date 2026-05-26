import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Blender exports glTF with Z-up convention but three.js is Y-up.
// The glTF spec says loaders should handle this, but baked world matrices
// from Blender files often still need a -90° X rotation applied.
const BLENDER_FIX = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

function showToast(msg, isError = false) {
  document.querySelectorAll('.export-toast').forEach(e => e.remove());
  const el = document.createElement('div');
  el.className = 'export-toast';
  if (isError) {
    el.style.borderColor = 'rgba(255,50,50,0.4)';
    el.style.color = '#f88';
  } else {
    el.style.borderColor = 'rgba(100,255,150,0.4)';
    el.style.color = '#8f9';
  }
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

export function setupImporter(objManager, updateUICallback) {
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.glb,.gltf';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  const loader = new GLTFLoader();

  fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    showToast(`Loading ${file.name}...`);
    const url = URL.createObjectURL(file);

    loader.load(
      url,
      (gltf) => {
        let importedCount = 0;

        // Ensure all loaded objects calculate their absolute positions
        gltf.scene.updateMatrixWorld(true);

        const meshesToImport = [];

        // Hunt down every individual mesh inside the GLTF file
        gltf.scene.traverse((node) => {
          if (node.isMesh) {
            const mesh = node.clone();

            // Bake the world matrix into the geometry so we can safely flatten the hierarchy
            mesh.geometry = mesh.geometry.clone();
            mesh.geometry.applyMatrix4(node.matrixWorld);

            // ── Fix Blender Z-up → three.js Y-up ──
            // After baking world matrix, rotate geometry -90° around X so
            // what was "up" in Blender (Z) becomes "up" in three.js (Y).
            mesh.geometry.applyMatrix4(BLENDER_FIX);

            // Reset local transforms since the geometry now holds the final position
            mesh.position.set(0, 0, 0);
            mesh.rotation.set(0, 0, 0);
            mesh.scale.set(1, 1, 1);
            mesh.updateMatrix();

            meshesToImport.push(mesh);
          }
        });

        // Add them into our engine's hierarchy
        meshesToImport.forEach(mesh => {
          objManager.addImportedMesh(mesh);
          importedCount++;
        });

        updateUICallback();
        showToast(`✓ Imported ${importedCount} meshes from ${file.name}`);

        URL.revokeObjectURL(url);
        fileInput.value = ''; // Reset so the same file can be re-imported
      },
      undefined,
      (error) => {
        console.error('GLTF Import Error:', error);
        showToast(`✗ Failed to import ${file.name}`, true);
        URL.revokeObjectURL(url);
        fileInput.value = '';
      }
    );
  });

  // Return a function that triggers the hidden file input
  return () => fileInput.click();
}

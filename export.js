import { OBJExporter }  from 'three/addons/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter }  from 'three/addons/exporters/STLExporter.js';
import * as THREE from 'three';

function download(filename, content, mimeType) {
  const blob = content instanceof Blob
    ? content
    : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showToast(msg, isError = false) {
  document.querySelectorAll('.export-toast').forEach(e => e.remove());
  const el = document.createElement('div');
  el.className = 'export-toast';
  if (isError) { el.style.borderColor = 'rgba(255,50,50,0.4)'; el.style.color = '#f88'; }
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// Blender is Z-up, Three.js is Y-up.
// This rotation matrix corrects the axis so the model
// stands upright when imported into Blender.
function makeBlenderRoot(objects) {
  const root = new THREE.Group();
  // -90° around X converts Y-up → Z-up
  root.rotation.x = -Math.PI / 2;
  objects.forEach(obj => {
    const clone = obj.clone();
    // Bake world matrix so positions/rotations export correctly
    clone.updateMatrixWorld(true);
    root.add(clone);
  });
  root.updateMatrixWorld(true);
  return root;
}

export function exportModel(objects, format, filenameStem) {
  // objects: array of THREE.Mesh
  const name = filenameStem || 'export';

  if (!objects || objects.length === 0) {
    showToast('✗ Nothing to export', true);
    return;
  }

  switch (format) {

    case 'obj': {
      const exporter = new OBJExporter();
      const group = new THREE.Group();
      objects.forEach(o => group.add(o.clone()));
      const result = exporter.parse(group);
      if (!result || result.trim() === '') { showToast('✗ OBJ export failed', true); return; }
      download(`${name}.obj`, result, 'text/plain');
      showToast(`✓ Exported ${name}.obj`);
      break;
    }

    case 'stl': {
      const exporter = new STLExporter();
      const group = new THREE.Group();
      objects.forEach(o => group.add(o.clone()));
      const result = exporter.parse(group, { binary: true });
      if (!result || result.byteLength === 0) { showToast('✗ STL export failed', true); return; }
      download(`${name}.stl`, new Blob([result], { type: 'application/octet-stream' }));
      showToast(`✓ Exported ${name}.stl`);
      break;
    }

    case 'gltf': {
      const exporter = new GLTFExporter();
      const root = makeBlenderRoot(objects);
      exporter.parse(
        root,
        (gltfJson) => {
          const str = JSON.stringify(gltfJson, null, 2);
          download(`${name}.gltf`, str, 'application/json');
          showToast(`✓ Exported ${name}.gltf`);
        },
        (err) => { console.error('GLTF export error:', err); showToast('✗ GLTF export failed', true); },
        { binary: false }
      );
      break;
    }

    case 'glb': {
      const exporter = new GLTFExporter();
      const root = makeBlenderRoot(objects);
      exporter.parse(
        root,
        (buffer) => {
          if (!buffer || buffer.byteLength === 0) { showToast('✗ GLB export failed', true); return; }
          download(`${name}.glb`, new Blob([buffer], { type: 'application/octet-stream' }));
          showToast(`✓ Exported ${name}.glb`);
        },
        (err) => { console.error('GLB export error:', err); showToast('✗ GLB export failed', true); },
        { binary: true }
      );
      break;
    }

    default:
      showToast('✗ Unknown format', true);
  }
}

// export.js — handles OBJ, GLTF, GLB, STL export
// All exporters come from Three.js addons, no extra dependencies needed.

import { OBJExporter }  from 'three/addons/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter }  from 'three/addons/exporters/STLExporter.js';

// Trigger a file download in the browser
function download(filename, content, mimeType) {
  const blob = content instanceof Blob
    ? content
    : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function showToast(msg) {
  document.querySelectorAll('.export-toast').forEach(e => e.remove());
  const el = document.createElement('div');
  el.className   = 'export-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// target: a single THREE.Mesh OR a THREE.Scene
export function exportModel(target, format, filenameStem) {
  const name = filenameStem || 'export';

  switch (format) {

    case 'obj': {
      const exporter = new OBJExporter();
      // OBJExporter accepts a single mesh or a group/scene
      const result = exporter.parse(target);
      download(`${name}.obj`, result, 'text/plain');
      showToast(`✓ Exported ${name}.obj`);
      break;
    }

    case 'stl': {
      const exporter = new STLExporter();
      // { binary: true } gives a smaller .stl file
      const result = exporter.parse(target, { binary: true });
      download(`${name}.stl`, new Blob([result], { type: 'application/octet-stream' }));
      showToast(`✓ Exported ${name}.stl`);
      break;
    }

    case 'gltf': {
      const exporter = new GLTFExporter();
      exporter.parse(
        target,
        (gltfJson) => {
          const str = JSON.stringify(gltfJson, null, 2);
          download(`${name}.gltf`, str, 'application/json');
          showToast(`✓ Exported ${name}.gltf`);
        },
        (err) => { console.error('GLTF export error:', err); showToast('✗ Export failed'); },
        { binary: false }
      );
      break;
    }

    case 'glb': {
      const exporter = new GLTFExporter();
      exporter.parse(
        target,
        (buffer) => {
          download(`${name}.glb`, new Blob([buffer], { type: 'application/octet-stream' }));
          showToast(`✓ Exported ${name}.glb`);
        },
        (err) => { console.error('GLB export error:', err); showToast('✗ Export failed'); },
        { binary: true }
      );
      break;
    }

    default:
      showToast('✗ Unknown format');
  }
}

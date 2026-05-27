import * as THREE from 'three';

const MAT_DEFAULT = new THREE.MeshLambertMaterial({
  color: 0xd4d4d4,
  side: THREE.DoubleSide,
});

export class ObjectManager {
  constructor(scene) {
    this.scene = scene;
    this.objects = [];
    this.selected = null;
    this.objectCount = 0;
  }

  // Returns a unique name: if "cube" exists, returns "cube (1)", "cube (2)" etc.
  _uniqueName(baseName) {
    const existing = new Set(this.objects.map(o => o.userData.name));
    if (!existing.has(baseName)) return baseName;
    let i = 1;
    while (existing.has(`${baseName} (${i})`)) i++;
    return `${baseName} (${i})`;
  }

  addObject(type) {
    let geo;
    switch(type) {
      case 'cube':     geo = new THREE.BoxGeometry(1, 1, 1); break;
      case 'sphere':   geo = new THREE.SphereGeometry(0.6, 32, 16); break;
      case 'cylinder': geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); break;
      case 'cone':     geo = new THREE.ConeGeometry(0.5, 1, 32); break;
      case 'torus':    geo = new THREE.TorusGeometry(0.5, 0.2, 16, 48); break;
      case 'plane':    geo = new THREE.PlaneGeometry(2, 2); break;
      default:         geo = new THREE.BoxGeometry(1, 1, 1);
    }

    const mesh = new THREE.Mesh(geo, MAT_DEFAULT.clone());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.name = this._uniqueName(type);

    if (type === 'plane') {
      mesh.position.set(0, 0, 0);
    } else {
      mesh.position.set(0, 0, 0.5);
    }

    this.scene.add(mesh);
    this.objects.push(mesh);
    this.selectObject(mesh);
    return mesh;
  }

  // --- NEW: Add Imported Mesh ---
  addImportedMesh(mesh) {
    // Ensure unique name based on the file's internal mesh name
    mesh.userData.name = this._uniqueName(mesh.name || 'Imported_Mesh');
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Clone materials so our red selection highlight doesn't bleed to other objects
    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(m => m.clone());
      } else {
        mesh.material = mesh.material.clone();
      }
    } else {
      mesh.material = MAT_DEFAULT.clone();
    }

    this.scene.add(mesh);
    this.objects.push(mesh);
    this.selectObject(mesh); // Auto-select it upon import
    return mesh;
  }

  duplicateObject(obj) {
    if (!obj) return null;
    const newMesh = obj.clone();
    // Clone gives same geometry+material refs; make material independent
    newMesh.material = obj.material.clone();
    newMesh.userData = { ...obj.userData };
    // Name: strip any existing "(n)" suffix, then re-unique
    const baseName = obj.userData.name.replace(/\s*\(\d+\)$/, '');
    newMesh.userData.name = this._uniqueName(baseName);
    // Offset slightly so it's visible
    newMesh.position.set(
      obj.position.x + 0.4,
      obj.position.y + 0.4,
      obj.position.z
    );
    this.scene.add(newMesh);
    this.objects.push(newMesh);
    this.selectObject(newMesh);
    return newMesh;
  }

  // Returns null on success, or an error string if name is taken
  renameObject(obj, newName) {
    if (!obj) return 'No object selected';
    const trimmed = newName.trim();
    if (!trimmed) return 'Name cannot be empty';
    const taken = this.objects.some(o => o !== obj && o.userData.name === trimmed);
    if (taken) return `"${trimmed}" already exists`;
    obj.userData.name = trimmed;
    return null;
  }

  deleteObject(obj) {
    if (!obj) return;
    this.scene.remove(obj);
    this.objects = this.objects.filter(o => o !== obj);
    if (this.selected === obj) this.selected = null;
  }

  deleteSelected() {
    this.deleteObject(this.selected);
  }

  // --- UPDATED: Smart color backup & restore ---
  selectObject(obj) {
    // 1. DESELECT current object (Restore its ORIGINAL color instead of forcing white)
    if (this.selected) {
      if (this.selected.userData.originalColor) {
        this.selected.material.color.copy(this.selected.userData.originalColor);
      } else {
        this.selected.material.color.set(0xffffff); // fallback to white
      }
      
      if (this.selected.material.emissive) {
          if (this.selected.userData.originalEmissive) {
            this.selected.material.emissive.copy(this.selected.userData.originalEmissive);
          } else {
            this.selected.material.emissive.set(0x000000);
          }
      }
    }
    
    this.selected = obj;
    
    // 2. SELECT new object (Backup its color, then turn it red)
    if (this.selected) {
      // Backup the original colors if we haven't already
      if (!this.selected.userData.originalColor) {
         this.selected.userData.originalColor = this.selected.material.color.clone();
         if (this.selected.material.emissive) {
             this.selected.userData.originalEmissive = this.selected.material.emissive.clone();
         }
      }
      
      // Make it glow Dark Neon Red
      this.selected.material.color.set(0xff0033);
      if (this.selected.material.emissive) {
          this.selected.material.emissive.set(0x440011);
      }
    }
  }

  getSelected()     { return this.selected; }
  getObjects()      { return this.objects; }
  getObjectCount()  { return this.objects.length; }

  // Returns a THREE.Group of all meshes — safe to pass to exporters
  // (excludes grid, lights, helpers)
  _exportGroup(THREE) {
    const group = new THREE.Group();
    this.objects.forEach(obj => group.add(obj.clone()));
    return group;
  }
}

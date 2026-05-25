import * as THREE from 'three';

const MAT_DEFAULT = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.3,
  metalness: 0.1
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

  selectObject(obj) {
    if (this.selected) {
      this.selected.material.color.set(0xffffff);
      this.selected.material.emissive.set(0x000000);
    }
    this.selected = obj;
    if (this.selected) {
      this.selected.material.color.set(0xff0033);
      this.selected.material.emissive.set(0x440011);
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

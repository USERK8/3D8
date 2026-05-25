import * as THREE from 'three';

// Clean white for default objects
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
    mesh.userData.name = type + '_' + (++this.objectCount);
    
    if (type === 'plane') { 
      mesh.rotation.x = 0; 
      mesh.position.set(0, 0, 0);
    } else {
      mesh.position.set(0, 0, 0.5); 
    }
    
    this.scene.add(mesh);
    this.objects.push(mesh);
    this.selectObject(mesh);
    
    return mesh;
  }

  deleteSelected() {
    if (!this.selected) return;
    this.scene.remove(this.selected);
    this.objects = this.objects.filter(o => o !== this.selected);
    this.selected = null;
  }

  selectObject(obj) {
    // Revert old selection back to white
    if (this.selected) {
      this.selected.material.color.set(0xffffff);
      this.selected.material.emissive.set(0x000000);
    }
    
    this.selected = obj;
    
    // Highlight new selection with Dark Neon Red
    if (this.selected) {
      this.selected.material.color.set(0xff0033);
      this.selected.material.emissive.set(0x440011); // Slight red glow
    }
  }

  getSelected() { return this.selected; }
  getObjects() { return this.objects; }
  getObjectCount() { return this.objects.length; }
}

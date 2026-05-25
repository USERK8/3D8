import * as THREE from 'three';

// Materials
const MAT_DEFAULT = new THREE.MeshStandardMaterial({ 
  color: 0xe8a838, 
  roughness: 0.6, 
  metalness: 0.1 
});

const MAT_SELECTED = new THREE.MeshStandardMaterial({ 
  color: 0xff6600, 
  roughness: 0.4, 
  metalness: 0.2, 
  emissive: 0x331100 
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
      case 'cube':     
        geo = new THREE.BoxGeometry(1, 1, 1); 
        break;
      case 'sphere':   
        geo = new THREE.SphereGeometry(0.6, 32, 16); 
        break;
      case 'cylinder': 
        geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); 
        break;
      case 'cone':     
        geo = new THREE.ConeGeometry(0.5, 1, 32); 
        break;
      case 'torus':    
        geo = new THREE.TorusGeometry(0.5, 0.2, 16, 48); 
        break;
      case 'plane':    
        geo = new THREE.PlaneGeometry(2, 2); 
        break;
      default:         
        geo = new THREE.BoxGeometry(1, 1, 1);
    }

    const mesh = new THREE.Mesh(geo, MAT_DEFAULT.clone());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.name = type + '_' + (++this.objectCount);
    
    // FIXED: Always spawn at origin (0, 0, 0)
    // For plane, rotate to lay flat on XY plane
    if (type === 'plane') { 
      mesh.rotation.x = 0; // Flat on XY plane (Z is up now)
      mesh.position.set(0, 0, 0);
    } else {
      // All other objects spawn at exact center
      mesh.position.set(0, 0, 0.5); // Slightly above ground
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
    // Deselect old
    if (this.selected) {
      this.selected.material.color.set(0xe8a838);
      this.selected.material.emissive.set(0x000000);
    }
    
    this.selected = obj;
    
    if (this.selected) {
      this.selected.material.color.set(0xff6600);
      this.selected.material.emissive.set(0x331100);
    }
  }

  getSelected() {
    return this.selected;
  }

  getObjects() {
    return this.objects;
  }

  getObjectCount() {
    return this.objects.length;
  }
}

import * as THREE from 'three';

/**
 * 标题界面背景动画：缓慢旋转的地牢方块阵列与巡回相机，纯装饰用途。
 */
import type { ViewRenderer } from './view';

export interface TitleBackdrop {
  readonly visible: boolean;
  attach(): void;
  detach(): void;
  update(dt: number): void;
}

export function createTitleBackdrop(renderer: ViewRenderer): TitleBackdrop {
  const group = new THREE.Group();
  let attached = false;
  let time = 0;

  const geo = new THREE.BoxGeometry(0.96, 1, 0.96);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a3550, roughness: 0.85, metalness: 0.1 });
  const matAccent = new THREE.MeshStandardMaterial({
    color: 0x8a6b2f,
    roughness: 0.5,
    metalness: 0.35,
  });

  const grid = 22;
  const mesh = new THREE.InstancedMesh(geo, mat, grid * grid);
  const accent = new THREE.InstancedMesh(geo.clone(), matAccent, 40);
  const m = new THREE.Matrix4();
  let a = 0;
  let seed = 1337;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  for (let x = 0; x < grid; x++) {
    for (let z = 0; z < grid; z++) {
      const i = x * grid + z;
      const h = Math.floor(rnd() * 3) * (rnd() > 0.65 ? 1 : 0);
      m.makeTranslation(x - grid / 2, h / 2 - 0.5, z - grid / 2);
      m.scale(new THREE.Vector3(1, Math.max(h, 0.12), 1));
      mesh.setMatrixAt(i, m);
      if (h >= 2 && a < accent.count) {
        m.makeTranslation(x - grid / 2, h + 0.35, z - grid / 2);
        accent.setMatrixAt(a++, m);
      }
    }
  }
  for (; a < accent.count; a++) accent.setMatrixAt(a, new THREE.Matrix4().makeScale(0, 0, 0));
  mesh.instanceMatrix.needsUpdate = true;
  accent.instanceMatrix.needsUpdate = true;
  group.add(mesh, accent);

  const hemi = new THREE.HemisphereLight(0xaabbff, 0x1a1410, 1.0);
  const key = new THREE.DirectionalLight(0xffdd99, 1.6);
  key.position.set(8, 16, 6);
  group.add(hemi, key);

  return {
    get visible() {
      return attached;
    },
    attach() {
      if (!attached) {
        renderer.scene.add(group);
        attached = true;
        group.visible = true;
      }
    },
    detach() {
      if (attached) {
        renderer.scene.remove(group);
        attached = false;
      }
    },
    update(dt: number): void {
      if (!attached) return;
      time += dt * 0.22;
      const radius = 26;
      renderer.camera.position.set(Math.cos(time) * radius, 13, Math.sin(time) * radius);
      renderer.camera.lookAt(0, 0, 0);
    },
  };
}

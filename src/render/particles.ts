/**
 * 粒子效果：命中火花与死亡爆散。
 *
 * 用一个固定容量的 InstancedMesh 小方块做粒子池，避免运行时分配对象。
 * 粒子按速度与重力积分，寿命结束时缩到 0（不销毁实例）。
 */

import * as THREE from 'three';

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  color: THREE.Color;
}

interface BurstOptions {
  count?: number;
  speed?: number;
  size?: number;
  /** 纵向初速，向上为正。 */
  lift?: number;
  gravity?: number;
}

export class ParticleField extends THREE.Group {
  readonly mesh: THREE.InstancedMesh;
  private pool: Particle[] = [];
  private tmpMatrix = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private scaleVec = new THREE.Vector3();

  constructor(capacity = 256) {
    super();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < capacity; i++) {
      this.pool.push({
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 0,
        maxLife: 1,
        size: 0.06,
        color: new THREE.Color(0xffffff),
      });
      this.mesh.setColorAt(i, this.pool[i].color);
      this.writeMatrix(i, 0);
    }
    this.add(this.mesh);
  }

  /** 当前活跃粒子数。 */
  get count(): number {
    let n = 0;
    for (const p of this.pool) if (p.life > 0) n++;
    return n;
  }

  /** 在一处喷出一团粒子。 */
  burst(x: number, y: number, z: number, color: number, options: BurstOptions = {}): void {
    const count = options.count ?? 12;
    const speed = options.speed ?? 1.6;
    const size = options.size ?? 0.06;
    const lift = options.lift ?? 1.2;
    for (let n = 0; n < count; n++) {
      const p = this.pool.find((q) => q.life <= 0);
      if (!p) return;
      const theta = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      p.x = x;
      p.y = y;
      p.z = z;
      p.vx = Math.cos(theta) * v;
      p.vz = Math.sin(theta) * v;
      p.vy = lift * (0.5 + Math.random());
      p.maxLife = 0.35 + Math.random() * 0.4;
      p.life = p.maxLife;
      p.size = size * (0.7 + Math.random() * 0.6);
      p.color.setHex(color);
      this.mesh.setColorAt(this.pool.indexOf(p), p.color);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.writeMatrix(i, 0);
        any = true;
        continue;
      }
      p.vy -= 4.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const k = p.life / p.maxLife;
      this.writeMatrix(i, p.size * k);
      any = true;
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }

  private writeMatrix(i: number, scale: number): void {
    const p = this.pool[i];
    this.quat.setFromEuler(new THREE.Euler(p.x * 2, p.y * 2, p.z * 2));
    this.scaleVec.setScalar(Math.max(0, scale));
    this.tmpMatrix.compose(new THREE.Vector3(p.x, p.y, p.z), this.quat, this.scaleVec);
    this.mesh.setMatrixAt(i, this.tmpMatrix);
  }
}

import * as THREE from 'three';

/**
 * 3D 视图的跟随相机。
 *
 * 以固定仰角环绕玩家，位移带阻尼；支持拖拽旋转与滚轮缩放。
 */
export class CameraRig {
  camera: THREE.PerspectiveCamera;
  target: THREE.Vector3;
  smoothTarget: THREE.Vector3;
  yaw: number;
  elevation: number;
  radius: number;
  minRadius: number;
  maxRadius: number;
  minElevation: number;
  maxElevation: number;
  followSpeed: number;
  private _desired: THREE.Vector3;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.target = new THREE.Vector3();
    this.smoothTarget = new THREE.Vector3();
    this.yaw = Math.PI * 0.25;
    this.elevation = THREE.MathUtils.degToRad(56);
    this.radius = 12;
    this.minRadius = 7;
    this.maxRadius = 30;
    this.minElevation = THREE.MathUtils.degToRad(22);
    this.maxElevation = THREE.MathUtils.degToRad(84);
    this.followSpeed = 8;
    this._desired = new THREE.Vector3();
  }

  /** 让相机对准某个世界坐标，通常是玩家。 */
  setTarget(
    x: number,
    y: number,
    z = 0,
    { immediate = false }: { immediate?: boolean } = {},
  ): void {
    this.target.set(x, y, z);
    if (immediate) this.smoothTarget.copy(this.target);
  }

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * 0.005;
    this.elevation = THREE.MathUtils.clamp(
      this.elevation + dy * 0.004,
      this.minElevation,
      this.maxElevation,
    );
  }

  zoom(delta: number): void {
    this.radius = THREE.MathUtils.clamp(
      this.radius * (1 + delta * 0.0012),
      this.minRadius,
      this.maxRadius,
    );
  }

  update(dt: number): void {
    const t = 1 - Math.exp(-this.followSpeed * dt);
    this.smoothTarget.lerp(this.target, t);
    const cosE = Math.cos(this.elevation);
    this._desired.set(
      this.smoothTarget.x + Math.sin(this.yaw) * cosE * this.radius,
      this.smoothTarget.y + Math.sin(this.elevation) * this.radius,
      this.smoothTarget.z + Math.cos(this.yaw) * cosE * this.radius,
    );
    this.camera.position.copy(this._desired);
    this.camera.lookAt(this.smoothTarget.x, this.smoothTarget.y + 0.4, this.smoothTarget.z);
  }
}

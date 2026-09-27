import * as THREE from 'three';

/**
 * 是否请求低质量档位：`?quality=low`。
 *
 * 用于高分屏或集成显卡上换取更稳的帧率，视觉差异只体现在抗锯齿与分辨率。
 */
function isLowQualityRequested(): boolean {
  try {
    return new URLSearchParams(location.search).get('quality') === 'low';
  } catch {
    return false;
  }
}

/**
 * 底层 three.js 渲染器：画布、相机、灯光、窗口尺寸处理与动画循环。
 * 具体场景内容由 render/scene.ts 负责。
 */
export class ViewRenderer {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  clock: THREE.Clock;
  updaters: Set<(dt: number) => void>;
  /** 低质量档位：关闭多重采样，像素比固定为 1。 */
  lowQuality: boolean;
  private _running: boolean;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // 质量档位只影响填充率：低档关掉多重采样并限制像素比，
    // 高分屏上像素数可减少到四分之一。几何侧压力很小（实测约 26 次绘制、
    // 1 万个三角面），真正的开销在设计像素数量上。
    this.lowQuality = isLowQualityRequested();
    const antialias = !this.lowQuality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias,
      powerPreference: 'high-performance',
    });
    this.applyPixelRatio();
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060a);
    this.scene.fog = new THREE.Fog(0x05060a, 18, 42);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.set(0, 14, 12);
    this.camera.lookAt(0, 0, 0);

    this.clock = new THREE.Clock();
    this.updaters = new Set();
    this._running = false;
    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._onResize();
  }

  /** 调整线性雾范围；标题页与地牢使用不同的观感。 */
  setFog(near: number, far: number): void {
    const fog = this.scene.fog;
    if (fog && 'near' in fog) {
      fog.near = near;
      fog.far = far;
    }
  }

  addUpdater(fn: (dt: number) => void): () => boolean {
    this.updaters.add(fn);
    return () => this.updaters.delete(fn);
  }

  /** 应用像素比。窗口在不同像素密度的显示器之间移动后需要重新调用。 */
  private applyPixelRatio(): void {
    const ratio = this.lowQuality ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(ratio);
  }

  private _onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.applyPixelRatio();
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this.clock.start();
    // 用 three.js 推荐的 setAnimationLoop：浏览器可据此调度回调，
    // 也便于将来接入 XR 或按显示刷新率对齐。
    this.renderer.setAnimationLoop(() => {
      const dt = Math.min(this.clock.getDelta(), 0.05);
      this.updaters.forEach((fn) => fn(dt));
      this.renderer.render(this.scene, this.camera);
    });
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    this.renderer.setAnimationLoop(null);
  }
}

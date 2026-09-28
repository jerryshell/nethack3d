import * as THREE from 'three';
import type { GameSession } from '../game/session';
import type { Level } from '../types';
import type { ViewRenderer } from './view';
import { DungeonMesh, tileToWorld } from './dungeonMesh';
import { createPlayerModel, createBlobShadow } from './models';
import { createCharacter } from './characters';
import type { CharacterHandle, CharacterKey } from './characters';
import { CameraRig } from './cameraRig';
import { EntityLayer } from './entities';
import { ParticleField } from './particles';
import { createLogger, LOG_NS } from '../core/log';
import { COLNO, ROWNO } from '../core/constants';

const log = createLogger(LOG_NS.render);
import { ItemLayer } from './itemLayer';

/**
 * 游戏运行时所需的 three.js 内容：灯光、当前楼层的地牢网格、
 * 玩家模型、火把与跟随相机。
 */
export class GameScene {
  renderer: ViewRenderer;
  root: THREE.Group;
  ambient: THREE.AmbientLight;
  hemi: THREE.HemisphereLight;
  moon: THREE.DirectionalLight;
  torch: THREE.PointLight;
  playerGroup: THREE.Group;
  playerModel: THREE.Group;
  /** 玩家的人物模型；素材不可用时为 null，此时用程序化模型。 */
  private playerCharacter: CharacterHandle | null = null;
  /** 玩家动作状态：移动中播放走路，动作结束后回到待机。 */
  private playerWalkTimer = 0;
  private playerAttackTimer = 0;
  /** 火把飞灰的生成计时。 */
  private emberTimer = 0;
  rig: CameraRig;
  dungeon: DungeonMesh | null;
  entities: EntityLayer;
  items: ItemLayer;
  /** 命中火花与死亡爆散的粒子池。 */
  particles: ParticleField;
  time: number;
  /** 光标所指格子的高亮框，null 表示没有指向可行走的格子。 */
  private hoverMark: THREE.Mesh;
  /** 点击移动的路径预览点。 */
  private pathDots: THREE.InstancedMesh;
  private pathShown = 0;

  constructor(renderer: ViewRenderer) {
    this.renderer = renderer;
    this.root = new THREE.Group();
    renderer.scene.add(this.root);

    // 地牢照明：冷色环境光 + 玩家身上的暖色火把。
    this.ambient = new THREE.AmbientLight(0x46516e, 1.15);
    this.hemi = new THREE.HemisphereLight(0xaec4ff, 0x322a20, 0.6);
    this.moon = new THREE.DirectionalLight(0xc8d8ff, 0.65);
    this.moon.position.set(-14, 24, -10);
    this.root.add(this.ambient, this.hemi, this.moon);

    this.torch = new THREE.PointLight(0xffb066, 2.1, 17, 1.75);
    this.torch.position.set(0, 1.15, 0);

    this.playerGroup = new THREE.Group();
    this.playerModel = createPlayerModel();
    this.playerGroup.add(this.playerModel, this.torch);
    this.playerGroup.add(createBlobShadow(0.36));
    this.root.add(this.playerGroup);

    this.entities = new EntityLayer();
    this.items = new ItemLayer();
    this.particles = new ParticleField();
    this.root.add(this.entities, this.items, this.particles);

    this.rig = new CameraRig(renderer.camera);
    this.dungeon = null;
    this.time = 0;

    // 光标高亮：一层贴地的细边方框，用叠加混合避免遮挡地形。
    this.hoverMark = new THREE.Mesh(
      new THREE.PlaneGeometry(0.92, 0.92),
      new THREE.MeshBasicMaterial({
        color: 0xffe6a8,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.hoverMark.rotation.x = -Math.PI / 2;
    this.hoverMark.position.y = 0.02;
    this.hoverMark.visible = false;
    this.root.add(this.hoverMark);

    // 路径预览：固定池子的圆点，按当前路径长度显示前若干个。
    this.pathDots = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.09, 10),
      new THREE.MeshBasicMaterial({
        color: 0xffd98a,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      128,
    );
    this.pathDots.rotation.x = 0;
    this.pathDots.count = 0;
    this.pathDots.frustumCulled = false;
    this.root.add(this.pathDots);

    renderer.scene.fog = new THREE.Fog(0x05060a, 26, 68);
  }

  /** 切换地牢楼层，并释放上一层网格。 */
  setLevel(level: Level, visible: Uint8Array | null = null): void {
    log.info('切换渲染关卡', { depth: level.depth });
    if (this.dungeon) {
      this.root.remove(this.dungeon);
      this.dungeon.dispose();
    }
    this.dungeon = new DungeonMesh(level);
    this.root.add(this.dungeon);
    this.dungeon.setVisibility(visible);
    this.entities.clearAll();
    this.items.clearAll();
  }

  /**
   * 按角色设定切换玩家模型。
   *
   * 人物素材可用时替换程序化模型，并播放待机动作。
   */
  setPlayerLook(look: { key: CharacterKey; tint?: string }): void {
    // 人物模型比一格略高，缩到 0.82 后与地牢设施比例协调。
    const character = createCharacter(look.key, { tint: look.tint, scale: 0.82 });
    if (!character) return;
    this.playerGroup.remove(this.playerModel);
    this.playerCharacter?.dispose();
    this.playerCharacter = character;
    character.root.name = 'player-character';
    this.playerGroup.add(character.root);
    character.play('idle');
    log.info('玩家模型已切换', { key: look.key });
  }

  /** 把角色移动到指定瓦片，并更新相机目标。 */
  setPlayer(x: number, y: number, { immediate = false }: { immediate?: boolean } = {}): void {
    const w = tileToWorld(x, y);
    const previous = this.playerGroup.position.clone();
    this.playerGroup.position.set(w.x, 0, w.z);
    this.rig.setTarget(w.x, 0.6, w.z, { immediate });
    if (!this.playerCharacter || immediate) return;
    const dx = w.x - previous.x;
    const dz = w.z - previous.z;
    if (dx * dx + dz * dz > 1e-4) {
      // 朝向行进方向，并切换到走路动作。
      const facing = Math.atan2(dx, dz);
      this.playerCharacter.root.rotation.y = facing;
      this.playerWalkTimer = 0.28;
      this.playerCharacter.play('walk');
    }
  }

  /** 播放一次攻击动作。 */
  playerAttack(): void {
    if (!this.playerCharacter) return;
    this.playerAttackTimer = 0.34;
    this.playerCharacter.play('attack-melee-right', { once: true, fade: 0.08 });
  }

  /** 播放死亡动作。 */
  playerDie(): void {
    this.playerCharacter?.play('die', { once: true, fade: 0.1 });
  }

  /**
   * 屏幕坐标换算成地面格子。
   *
   * 直接与 y=0 平面求交，比逐个网格做射线检测便宜且不受地形起伏影响。
   * 返回 null 表示视线没有落在地面上。
   */
  tileFromScreen(clientX: number, clientY: number): { x: number; y: number } | null {
    const canvas = this.renderer.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.renderer.camera);
    const hit = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    if (!raycaster.ray.intersectPlane(plane, hit)) return null;
    return {
      x: Math.round(hit.x + (COLNO - 1) / 2),
      y: Math.round(hit.z + (ROWNO - 1) / 2),
    };
  }

  /** 高亮光标所指的格子；传 null 取消高亮。 */
  setHoverTile(tile: { x: number; y: number } | null): void {
    if (!tile) {
      this.hoverMark.visible = false;
      return;
    }
    const w = tileToWorld(tile.x, tile.y);
    this.hoverMark.position.set(w.x, 0.02, w.z);
    this.hoverMark.visible = true;
  }

  /** 显示点击移动的路径预览。 */
  setPathPreview(points: Array<{ x: number; y: number }>): void {
    const limit = Math.min(points.length, this.pathDots.count === 0 ? 128 : 128);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const scale = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < points.length && i < 128; i++) {
      const w = tileToWorld(points[i].x, points[i].y);
      matrix.compose(new THREE.Vector3(w.x, 0.03, w.z), quaternion, scale);
      this.pathDots.setMatrixAt(i, matrix);
    }
    this.pathShown = Math.min(limit, 128);
    this.pathDots.count = this.pathShown;
    this.pathDots.instanceMatrix.needsUpdate = true;
  }

  setVisibility(visible: Uint8Array | null): void {
    if (this.dungeon) this.dungeon.setVisibility(visible);
  }

  /** 同步怪物与地面物品视图。 */
  syncEntities(session: GameSession): void {
    this.entities.sync(session);
    this.items.sync(session);
  }

  /** 在怪物位置喷出命中火花；killed 时改成死亡爆散。 */
  spawnMonsterSparks(monsterId: number, color: number, killed = false): void {
    const pos = this.entities.positionOf(monsterId);
    if (!pos) return;
    this.particles.burst(
      pos.x,
      pos.y + 0.5,
      pos.z,
      color,
      killed
        ? { count: 26, speed: 2.6, lift: 2.2, size: 0.09 }
        : { count: 10, speed: 1.5, lift: 1.1 },
    );
  }

  /** 在指定世界坐标喷出粒子（供端到端与工具使用）。 */
  spawnBurstAt(x: number, y: number, z: number, color: number, count = 12): void {
    this.particles.burst(x, y, z, color, { count });
  }

  update(dt: number): void {
    this.time += dt;
    // 火把闪烁。
    const flicker = 1 + Math.sin(this.time * 9.1) * 0.05 + Math.sin(this.time * 23.7 + 1.3) * 0.035;
    this.torch.intensity = 2.1 * flicker;
    if (this.playerCharacter) {
      // 人物模型自带动作，不再做整体的上下起伏。
      this.playerWalkTimer = Math.max(0, this.playerWalkTimer - dt);
      this.playerAttackTimer = Math.max(0, this.playerAttackTimer - dt);
      if (this.playerWalkTimer === 0 && this.playerAttackTimer === 0) {
        this.playerCharacter.play('idle');
      }
      this.playerCharacter.update(dt);
    } else {
      // 程序化模型没有骨骼，用轻微起伏代替待机动作。
      this.playerGroup.position.y = Math.sin(this.time * 3.2) * 0.02;
    }
    if (this.dungeon) this.dungeon.update(dt);
    this.entities.update(dt);
    this.items.update(dt);
    this.particles.update(dt);
    // 火把飞灰：玩家身边缓慢升起的小火星。
    this.emberTimer -= dt;
    if (this.emberTimer <= 0) {
      this.emberTimer = 0.35 + Math.random() * 0.25;
      const p = this.playerGroup.position;
      this.particles.burst(
        p.x + (Math.random() - 0.5) * 1.4,
        0.35 + Math.random() * 0.5,
        p.z + (Math.random() - 0.5) * 1.4,
        0xffa54f,
        { count: 1, speed: 0.06, lift: 0.32, size: 0.035 },
      );
    }
    this.rig.update(dt);
  }

  dispose(): void {
    log.info('释放游戏场景');
    this.playerCharacter?.dispose();
    this.playerCharacter = null;
    this.hoverMark.geometry.dispose();
    (this.hoverMark.material as THREE.Material).dispose();
    this.pathDots.geometry.dispose();
    (this.pathDots.material as THREE.Material).dispose();
    this.entities.clearAll();
    this.items.clearAll();
    if (this.dungeon) {
      this.root.remove(this.dungeon);
      this.dungeon.dispose();
      this.dungeon = null;
    }
    this.renderer.scene.remove(this.root);
  }
}

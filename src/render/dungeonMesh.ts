import * as THREE from 'three';
import type { DoorState, Level } from '../types';
import { createLogger, LOG_NS } from '../core/log';
import { COLNO, ROWNO, T, isWall, isLiquid } from '../core/constants';
import { doorBlocksEastWest, index } from '../game/dungeon';
import {
  PALETTE,
  tileColor,
  tileNoise,
  lambertOf,
  REMEMBERED_TINT,
  REMEMBERED_SCALE,
} from './palette';
import { modelGeometry, modelMaterial } from './assets';
import { enableShadows } from './models';

const log = createLogger(LOG_NS.render);

const WALL_HEIGHT = 1.15;
const FLOOR_THICKNESS = 0.14;

/** 瓦片中心转世界坐标，关卡以原点为中心。 */
export function tileToWorld(x: number, y: number): { x: number; z: number } {
  return { x: x - (COLNO - 1) / 2, z: y - (ROWNO - 1) / 2 };
}

/** 在顶点色中烘焙明暗的立方体几何体：顶面较亮，底面较暗。 */
function shadedBox(
  w: number,
  h: number,
  d: number,
  topShade = 1.0,
  sideShade = 0.82,
  bottomShade = 0.55,
): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  const pos = geo.attributes.position;
  const normal = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const ny = normal.getY(i);
    const shade = ny > 0.5 ? topShade : ny < -0.5 ? bottomShade : sideShade;
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade;
    colors[i * 3 + 2] = shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// ---------------------------------------------------------------------------
// Instanced terrain batches
// ---------------------------------------------------------------------------

/**
 * 一批相同的立方体，每个瓦片一个实例；逐实例颜色由迷雾状态决定。
 * 未见过的实例缩放到零，以最低成本隐藏。
 */
class InstancedKind {
  level: Level;
  geometry: THREE.BufferGeometry;
  tiles: number[];
  mesh: THREE.InstancedMesh;
  hidden: Uint8Array;
  baseColors: Float32Array;
  private _matrix: THREE.Matrix4;
  private _color: THREE.Color;
  private _pos: THREE.Vector3;
  private _quat: THREE.Quaternion;
  private _unit: THREE.Vector3;
  private _zero: THREE.Vector3;

  constructor(
    level: Level,
    geometry: THREE.BufferGeometry,
    tiles: number[],
    { opacity = 1 }: { opacity?: number } = {},
  ) {
    this.level = level;
    this.geometry = geometry;
    this.tiles = tiles;
    this.mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshLambertMaterial({
        vertexColors: true,
        transparent: opacity < 1,
        opacity,
      }),
      Math.max(tiles.length, 1),
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = tiles.length;
    this.hidden = new Uint8Array(tiles.length);
    this.baseColors = new Float32Array(tiles.length * 3);
    this._matrix = new THREE.Matrix4();
    this._color = new THREE.Color();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._unit = new THREE.Vector3(1, 1, 1);
    this._zero = new THREE.Vector3(0, 0, 0);

    for (let n = 0; n < tiles.length; n++) {
      const i = tiles[n];
      const x = i % COLNO;
      const y = (i / COLNO) | 0;
      const w = tileToWorld(x, y);
      const color = tileColor(level.tiles[i], x, y);
      const noise = 0.9 + tileNoise(x, y) * 0.2;
      this._color.setHex(color).multiplyScalar(noise);
      this.baseColors[n * 3] = this._color.r;
      this.baseColors[n * 3 + 1] = this._color.g;
      this.baseColors[n * 3 + 2] = this._color.b;
      this.mesh.setColorAt(n, this._color);
      this._pos.set(w.x, 0, w.z);
      this._quat.identity();
      this._matrix.compose(this._pos, this._quat, this._zero);
      this.mesh.setMatrixAt(n, this._matrix);
      this.hidden[n] = 1;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  _place(n: number, i: number, visible: boolean): void {
    const x = i % COLNO;
    const y = (i / COLNO) | 0;
    const w = tileToWorld(x, y);
    this._pos.set(w.x, 0, w.z);
    this._quat.identity();
    this._matrix.compose(this._pos, this._quat, visible ? this._unit : this._zero);
    this.mesh.setMatrixAt(n, this._matrix);
    this.hidden[n] = visible ? 0 : 1;
  }

  /** Apply fog-of-war state for every instance. */
  update(visibleMap: Uint8Array | null): void {
    let dirtyMatrix = false;
    for (let n = 0; n < this.tiles.length; n++) {
      const i = this.tiles[n];
      const seen = this.level.seen[i] === 1;
      const visible = !!visibleMap && visibleMap[i] === 1;
      if (seen === !this.hidden[n]) {
        // no state change
      } else if (seen) {
        this._place(n, i, true);
        dirtyMatrix = true;
      } else {
        this._place(n, i, false);
        dirtyMatrix = true;
      }
      if (!seen) continue;
      this._color.setRGB(
        this.baseColors[n * 3],
        this.baseColors[n * 3 + 1],
        this.baseColors[n * 3 + 2],
      );
      if (!visible) this._color.multiplyScalar(REMEMBERED_SCALE).lerp(REMEMBERED_TINT, 0.35);
      this.mesh.setColorAt(n, this._color);
    }
    if (dirtyMatrix) this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------------------
// Feature models
// ---------------------------------------------------------------------------

/** 克隆组内材质，使迷雾变暗逐个设施独立生效。 */
function isolateMaterials(group: THREE.Group): THREE.Group {
  const seen = new Set<THREE.Material>();
  group.traverse((o) => {
    const material = lambertOf(o);
    if (!material || seen.has(material)) return;
    seen.add(material);
    const clone = material.clone();
    (o as THREE.Mesh).material = clone;
    o.userData.baseColor = clone.color.clone();
  });
  return group;
}

function buildDoor(level: Level, x: number, y: number, door: DoorState): THREE.Group {
  const g = new THREE.Group();
  // 朝向判定与生成器共用同一份逻辑，避免两处各写一套而判反。
  const passageAlongX = doorBlocksEastWest(level, x, y);

  const frameMat = new THREE.MeshLambertMaterial({ vertexColors: true, color: 0x5a4632 });
  const post = shadedBox(0.12, 1.05, 0.12, 1.0, 0.85, 0.5);
  const left = new THREE.Mesh(post, frameMat);
  const right = new THREE.Mesh(post, frameMat);
  const half = 0.47;
  if (passageAlongX) {
    left.position.set(0, 0.52, -half);
    right.position.set(0, 0.52, half);
  } else {
    left.position.set(-half, 0.52, 0);
    right.position.set(half, 0.52, 0);
  }
  const pivot = new THREE.Group();
  const gate = modelGeometry('gate');
  const gateMaterial = modelMaterial();
  let panel: THREE.Mesh;
  if (gate && gateMaterial) {
    // 栅门模型沿 X 轴展开，通道沿 Z 时旋转 90 度；模型底面在 y=0，
    // 因此相对转轴下沉半个门高，使门板贴地。
    panel = new THREE.Mesh(gate, gateMaterial);
    if (passageAlongX) panel.rotation.y = Math.PI / 2;
    panel.position.y = -0.48;
  } else {
    const panelMat = new THREE.MeshLambertMaterial({ vertexColors: true, color: PALETTE.doorWood });
    panel = new THREE.Mesh(
      passageAlongX
        ? shadedBox(0.1, 0.92, 0.86, 1.0, 0.8, 0.5)
        : shadedBox(0.86, 0.92, 0.1, 1.0, 0.8, 0.5),
      panelMat,
    );
  }
  // 转轴在格子边缘，门板相对转轴偏移半格，闭合时正好落在格子中央。
  // panel.position 是相对转轴的偏移，不是绝对坐标。
  if (passageAlongX) {
    pivot.position.set(0, 0.48, -half);
    panel.position.z = half;
  } else {
    pivot.position.set(-half, 0.48, 0);
    panel.position.x = half;
  }
  pivot.add(panel);
  // 锁闩常驻，靠可见性反映锁定状态：开门或解锁时不必重建整层网格。
  const band = new THREE.Mesh(
    passageAlongX ? shadedBox(0.13, 0.12, 0.5) : shadedBox(0.5, 0.12, 0.13),
    new THREE.MeshLambertMaterial({ vertexColors: true, color: PALETTE.doorMetal }),
  );
  band.position.y = 0.1;
  band.visible = door.locked;
  pivot.add(band);
  // 被撞破的门只剩断板，散落在门槛上。
  const debris = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const plank = new THREE.Mesh(shadedBox(0.34, 0.05, 0.1, 1.0, 0.8, 0.5), frameMat);
    plank.position.set(-0.18 + i * 0.16, 0.03 + i * 0.02, -0.1 + i * 0.12);
    plank.rotation.y = 0.4 - i * 0.5;
    debris.add(plank);
  }
  debris.visible = door.broken;
  panel.visible = !door.broken;
  const openRotation = passageAlongX ? Math.PI / 2.3 : -Math.PI / 2.3;
  if (!door.closed) pivot.rotation.y = openRotation;
  g.add(left, right, pivot, debris);
  g.userData.animate = {
    pivot,
    panel,
    band,
    debris,
    closed: door.closed,
    broken: door.broken,
    openRotation,
  };
  return g;
}

function buildStairs(direction: 'up' | 'down' | 'branch'): THREE.Group {
  const g = new THREE.Group();
  // 分支楼梯按下行处理：同样通向地下。
  const down = direction !== 'up';
  const model = modelGeometry('stairs');
  const modelMat = modelMaterial();
  if (model && modelMat) {
    const mesh = new THREE.Mesh(model, modelMat);
    // 上行楼梯顺坡而上；下行转 180 度并下沉，配合下方的暗色竖井。
    if (down) {
      mesh.rotation.y = Math.PI;
      mesh.position.y = -0.2;
    }
    g.add(mesh);
  } else {
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      color: down ? PALETTE.stairsDown : PALETTE.stairsUp,
      emissive: down ? 0x2a1f00 : 0x10131a,
    });
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const step = new THREE.Mesh(shadedBox(0.78, 0.16, 0.78, 1.0, 0.85, 0.6), mat);
      step.position.set(0, down ? -0.08 - i * 0.16 : 0.08 + i * 0.16, 0);
      g.add(step);
    }
  }
  if (down) {
    const shaft = new THREE.Mesh(
      shadedBox(0.8, 0.02, 0.8, 0.25, 0.25, 0.25),
      new THREE.MeshLambertMaterial({ vertexColors: true, color: 0x080809 }),
    );
    shaft.position.y = -0.78;
    g.add(shaft);
  }
  return g;
}

function buildFountain() {
  const g = new THREE.Group();
  const basin = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.46, 0.36, 16, 1, true),
    new THREE.MeshLambertMaterial({ color: PALETTE.fountainStone, side: THREE.DoubleSide }),
  );
  basin.position.y = 0.18;
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(0.38, 16),
    new THREE.MeshLambertMaterial({
      color: PALETTE.fountainWater,
      transparent: true,
      opacity: 0.9,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.28;
  const pillar = new THREE.Mesh(
    shadedBox(0.14, 0.5, 0.14),
    new THREE.MeshLambertMaterial({ vertexColors: true, color: PALETTE.fountainStone }),
  );
  pillar.position.y = 0.5;
  g.add(basin, water, pillar);
  return g;
}

function buildSink() {
  const g = new THREE.Group();
  const basin = new THREE.Mesh(
    shadedBox(0.66, 0.3, 0.5, 1.0, 0.85, 0.6),
    new THREE.MeshLambertMaterial({ vertexColors: true, color: PALETTE.sinkMetal }),
  );
  basin.position.y = 0.15;
  const tap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 0.4, 8),
    new THREE.MeshLambertMaterial({ color: PALETTE.sinkMetal }),
  );
  tap.position.set(0, 0.5, -0.18);
  g.add(basin, tap);
  return g;
}

function buildAltar() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(
    shadedBox(0.8, 0.55, 0.8, 1.0, 0.85, 0.6),
    new THREE.MeshLambertMaterial({ vertexColors: true, color: PALETTE.altarStone }),
  );
  base.position.y = 0.28;
  const top = new THREE.Mesh(
    shadedBox(0.62, 0.08, 0.62, 1.0, 0.9, 0.7),
    new THREE.MeshLambertMaterial({
      vertexColors: true,
      color: PALETTE.altarGlow,
      emissive: PALETTE.altarGlow,
      emissiveIntensity: 0.2,
    }),
  );
  top.position.y = 0.59;
  g.add(base, top);
  return g;
}

function buildGrave() {
  const g = new THREE.Group();
  const dirt = new THREE.Mesh(
    shadedBox(0.9, 0.06, 0.9, 0.8, 0.7, 0.5),
    new THREE.MeshLambertMaterial({ vertexColors: true, color: 0x4a3b2a }),
  );
  const stone = new THREE.Mesh(
    shadedBox(0.5, 0.8, 0.14, 1.0, 0.85, 0.6),
    new THREE.MeshLambertMaterial({ vertexColors: true, color: PALETTE.grave }),
  );
  stone.position.set(0, 0.42, -0.2);
  stone.rotation.x = -0.12;
  g.add(dirt, stone);
  return g;
}

function buildThrone() {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, color: PALETTE.throne });
  const seat = new THREE.Mesh(shadedBox(0.62, 0.18, 0.62, 1.0, 0.9, 0.6), mat);
  seat.position.y = 0.38;
  const back = new THREE.Mesh(shadedBox(0.62, 0.7, 0.14, 1.0, 0.9, 0.6), mat);
  back.position.set(0, 0.72, -0.24);
  g.add(seat, back);
  for (const [lx, lz] of [
    [-0.24, 0.24],
    [0.24, 0.24],
    [-0.24, -0.24],
    [0.24, -0.24],
  ]) {
    const leg = new THREE.Mesh(shadedBox(0.12, 0.38, 0.12, 0.9, 0.8, 0.6), mat);
    leg.position.set(lx, 0.19, lz);
    g.add(leg);
  }
  return g;
}

const TRAP_COLOR: Record<string, number> = {
  FIRE_TRAP: 0xff5522,
  TELEP_TRAP: 0x5555ff,
  LEVEL_TELEP: 0x5555ff,
  MAGIC_TRAP: 0xff55ff,
  ANTI_MAGIC: 0x55ffff,
  POLY_TRAP: 0xff55ff,
  VIBRATING_SQUARE: 0xff55ff,
};

function buildTrap(type: string): THREE.Group {
  const g = new THREE.Group();
  const color = TRAP_COLOR[type] ?? PALETTE.trap;
  const model = modelGeometry('trap');
  const atlas = modelMaterial();
  if (model && atlas) {
    // 模型提供形状，颜色仍按陷阱类型区分。
    g.add(
      new THREE.Mesh(
        model,
        new THREE.MeshLambertMaterial({
          map: atlas.map,
          color,
          emissive: color,
          emissiveIntensity: 0.3,
        }),
      ),
    );
    return g;
  }
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 0.06, 12),
    new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.3 }),
  );
  disc.position.y = 0.05;
  g.add(disc);
  return g;
}

const FEATURE_BUILDERS = {
  FOUNTAIN: buildFountain,
  SINK: buildSink,
  ALTAR: buildAltar,
  GRAVE: buildGrave,
  THRONE: buildThrone,
};

/** 门的手柄数据：每帧从这里读取关卡状态，驱动开合动画与锁闩、断板。 */
interface DoorAnimation {
  pivot: THREE.Group;
  panel: THREE.Mesh;
  band: THREE.Mesh;
  debris: THREE.Group;
  closed: boolean;
  broken: boolean;
  openRotation: number;
}

// ---------------------------------------------------------------------------

/**
 * 单层地牢的 3D 呈现。
 *
 * `setVisibility()` 每回合应用迷雾状态，`update()` 播放门的开合动画。
 */
export class DungeonMesh extends THREE.Group {
  level: Level;
  kinds: InstanceType<typeof InstancedKind>[];
  features: THREE.Group[];

  constructor(level: Level) {
    super();
    this.level = level;
    this.kinds = [];
    this.features = [];
    this.name = `dungeon-d${level.depth}`;
    this._build();
    this.setVisibility(null);
  }

  private _build(): void {
    const floors = [];
    const walls = [];
    const liquids = [];
    for (let i = 0; i < this.level.tiles.length; i++) {
      const t = this.level.tiles[i];
      if (t === T.STONE) continue;
      // 未发现的密门按墙渲染，搜索或探门后会重建网格现出原形。
      if (isWall(t) || (t === T.SDOOR && this.level.doors.get(i)?.hidden === true)) {
        walls.push(i);
      } else if (isLiquid(t)) liquids.push(i);
      else floors.push(i);
    }

    const floorKind = new InstancedKind(
      this.level,
      shadedBox(1, FLOOR_THICKNESS, 1, 1.0, 0.9, 0.5),
      floors,
    );
    floorKind.mesh.position.y = -FLOOR_THICKNESS / 2;
    floorKind.mesh.receiveShadow = true;
    this.add(floorKind.mesh);
    this.kinds.push(floorKind);

    const wallKind = new InstancedKind(
      this.level,
      shadedBox(1, WALL_HEIGHT, 1, 1.0, 0.78, 0.45),
      walls,
    );
    wallKind.mesh.position.y = WALL_HEIGHT / 2;
    wallKind.mesh.castShadow = true;
    wallKind.mesh.receiveShadow = true;
    this.add(wallKind.mesh);
    this.kinds.push(wallKind);

    if (liquids.length) {
      const liquidKind = new InstancedKind(this.level, shadedBox(1, 0.06, 1), liquids, {
        opacity: 0.85,
      });
      liquidKind.mesh.position.y = -0.05;
      liquidKind.mesh.receiveShadow = true;
      this.add(liquidKind.mesh);
      this.kinds.push(liquidKind);
    }

    const addFeature = (i: number, group: THREE.Group, kind: string): void => {
      const x = i % COLNO;
      const y = (i / COLNO) | 0;
      const w = tileToWorld(x, y);
      group.position.set(w.x, 0, w.z);
      group.userData.tile = i;
      group.userData.kind = kind;
      isolateMaterials(group);
      // 设施投射并接收阴影，让门扇、楼梯与祭坛在地面上留下真实影子。
      enableShadows(group);
      this.add(group);
      this.features.push(group);
    };

    for (const [i, door] of this.level.doors) {
      // 密门未发现前不建门扇，它按墙渲染。
      if (door.hidden) continue;
      const x = i % COLNO;
      const y = (i / COLNO) | 0;
      addFeature(i, buildDoor(this.level, x, y, door), 'door');
    }
    for (const s of this.level.stairs) {
      addFeature(index(s.x, s.y), buildStairs(s.dir), 'stairs');
    }
    for (const [i, feat] of this.level.features) {
      const fn = (FEATURE_BUILDERS as Record<string, (() => THREE.Group) | undefined>)[feat.type];
      if (fn) addFeature(i, fn(), feat.type);
    }
    for (const [i, trap] of this.level.traps) {
      addFeature(i, buildTrap(trap.type), 'trap');
    }

    log.debug('地牢网格构建完成', {
      depth: this.level.depth,
      floors: floors.length,
      walls: walls.length,
      liquids: liquids.length,
      features: this.features.length,
    });
  }

  /** 应用视野结果：未见隐藏、记忆变暗、可见照亮。 */
  setVisibility(visible: Uint8Array | null): void {
    for (const kind of this.kinds) kind.update(visible);
    for (const f of this.features) {
      const i = f.userData.tile;
      const seen = this.level.seen[i] === 1;
      const isVisible = !!visible && visible[i] === 1;
      // 陷阱要踩过或被发现才可见，不再随地形一起暴露。
      if (f.userData.kind === 'trap' && this.level.traps.get(i)?.seen !== true) {
        f.visible = false;
        continue;
      }
      f.visible = seen;
      f.traverse((o) => {
        const material = lambertOf(o);
        const base = o.userData.baseColor as THREE.Color | undefined;
        if (material && base) {
          material.color.copy(base);
          if (seen && !isVisible) {
            material.color.multiplyScalar(REMEMBERED_SCALE).lerp(REMEMBERED_TINT, 0.35);
          }
        }
      });
    }
  }

  /** 播放开门动画，并同步锁闩与破门状态，每帧调用。 */
  update(dt: number): void {
    for (const f of this.features) {
      const anim = f.userData.animate as DoorAnimation | undefined;
      if (!anim) continue;
      // 门的状态在玩家、怪物或法术的行动里改变，这里每帧读回关卡状态，
      // 不能沿用建网格时的快照，否则开了门模型也不动。
      const door = this.level.doors.get(f.userData.tile as number);
      if (door) {
        anim.closed = door.closed;
        anim.broken = door.broken;
        anim.panel.visible = !door.broken;
        anim.debris.visible = door.broken;
        anim.band.visible = door.locked && door.closed && !door.broken;
      }
      const target = anim.closed ? 0 : anim.openRotation;
      const cur = anim.pivot.rotation.y;
      const delta = target - cur;
      if (Math.abs(delta) > 0.005) {
        anim.pivot.rotation.y = cur + Math.sign(delta) * Math.min(Math.abs(delta), dt * 5);
      }
    }
  }

  dispose(): void {
    log.debug('释放地牢网格', { depth: this.level.depth, batches: this.kinds.length });
    for (const kind of this.kinds) kind.dispose();
    for (const f of this.features) {
      f.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
    }
  }
}

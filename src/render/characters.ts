/**
 * 带骨骼动画的人物模型。
 *
 * 素材来自 Kenney 的 Mini 系列（CC0），每个模型自带 32 段动画，
 * 常用的是 idle、walk、attack-melee-right、die。
 * 由 `tools/sync-assets.ts` 同步到 `public/assets/kenney/characters/`。
 *
 * 每个实例都有自己的材质副本，因此可以按怪物数据里的颜色染色；
 * 加载失败时返回 null，调用方回退到程序化模型。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { createLogger, LOG_NS } from '../core/log';

const log = createLogger(LOG_NS.render);

/** 素材根路径，相对文档地址。 */
const BASE = 'assets/kenney/characters/';

/** 可选模型；键名同时用于按族群稳定分配。 */
export const CHARACTER_KEYS = ['human', 'orc', 'knight', 'rogue'] as const;
export type CharacterKey = (typeof CHARACTER_KEYS)[number];

interface LoadedCharacter {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
  /** 原始材质的贴图，实例化时复用。 */
  map: THREE.Texture | null;
}

const loaded = new Map<CharacterKey, LoadedCharacter>();
let ready = false;

/** 角色素材是否已就绪。 */
export function charactersReady(): boolean {
  return ready;
}

/** 已加载的模型数量，写入渲染指标。 */
export function loadedCharacterCount(): number {
  return loaded.size;
}

/** 加载全部人物模型。失败时返回 false，调用方回退。 */
export async function loadCharacters(): Promise<boolean> {
  try {
    const loader = new GLTFLoader();
    const results = await Promise.all(
      CHARACTER_KEYS.map(async (key) => {
        const gltf = await loader.loadAsync(`${BASE}${key}.glb`);
        // 取骨架蒙皮的贴图，后续自建 Lambert 材质时复用。
        let map: THREE.Texture | null = null;
        gltf.scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (map || !mesh.isMesh) return;
          const material = mesh.material as THREE.MeshStandardMaterial | undefined;
          map = material?.map ?? null;
        });
        // 显式标注类型：贴图在回调里赋值，推断会把它当成 null。
        const entry: LoadedCharacter = { scene: gltf.scene, clips: gltf.animations, map };
        return [key, entry] as const;
      }),
    );
    for (const [key, value] of results) {
      if (!value.map) throw new Error(`人物模型缺少贴图：${key}`);
      value.map.colorSpace = THREE.SRGBColorSpace;
      value.map.magFilter = THREE.NearestFilter;
      loaded.set(key, value);
    }
    ready = true;
    log.info('人物素材已加载', { models: loaded.size });
    return true;
  } catch (error) {
    loaded.clear();
    ready = false;
    log.warn('人物素材加载失败，回退到程序化模型', { error: String(error) });
    return false;
  }
}

/**
 * 人形族群的字形。
 *
 * 只有这些用人物模型；蚂蚁、蝙蝠、巨龙之类保留程序化外形，
 * 否则一只灰狼长着人形会很怪。
 */
const HUMANOID_GLYPHS = new Set([
  '@',
  '&',
  'A',
  'h',
  'n',
  'p',
  'G',
  'k',
  'O',
  'T',
  'V',
  'W',
  'Z',
  'i',
  'g',
]);

/** 按体型换算模型缩放。 */
const SIZE_SCALE: Record<string, number> = {
  MZ_TINY: 0.5,
  MZ_SMALL: 0.62,
  MZ_MEDIUM: 0.78,
  MZ_HUMAN: 0.9,
  MZ_LARGE: 1.05,
  MZ_HUGE: 1.25,
  MZ_GIGANTIC: 1.5,
};

/**
 * 怪物对应的模型与缩放。
 *
 * 人形族群按族群名稳定地分配到一个模型，因此同族怪物外形一致，
 * 跨层也保持稳定；返回 null 表示仍用程序化模型。
 */
export function lookForMonster(data: {
  glyph: string;
  symClass: string;
  size: string;
}): { key: CharacterKey; scale: number } | null {
  if (!data.glyph || !HUMANOID_GLYPHS.has(data.glyph)) return null;
  let hash = 0;
  for (const ch of data.symClass) hash = (hash * 31 + ch.charCodeAt(0)) % 9973;
  // 兽人、巨人一类固定用兽人模型，其余按族群散列。
  const key =
    data.glyph === 'O' || data.symClass.startsWith('GIANT')
      ? 'orc'
      : CHARACTER_KEYS[hash % CHARACTER_KEYS.length];
  return { key, scale: SIZE_SCALE[data.size] ?? 0.8 };
}

/** 玩家模型：按种族与性别挑选。 */
export function lookForPlayer(
  raceId: string,
  gender: string,
): { key: CharacterKey; tint?: string } {
  if (raceId === 'ORC') return { key: 'orc' };
  if (raceId === 'ELF') return { key: gender === 'female' ? 'rogue' : 'knight', tint: '#b8e0c0' };
  if (raceId === 'GNOME') return { key: 'human', tint: '#f0d890' };
  if (raceId === 'DWARF') return { key: 'human', tint: '#d8b088' };
  return { key: gender === 'female' ? 'rogue' : 'knight' };
}

/** 一个可播放动画的角色实例。 */
export interface CharacterHandle {
  /** 挂到场景里的根节点。 */
  root: THREE.Group;
  /** 播放动画；once 表示只播一次，结束后回到上一个循环动作。 */
  play(name: string, options?: { once?: boolean; fade?: number }): void;
  /** 当前播放的动作名。 */
  current(): string | null;
  /** 推进动画。 */
  update(dt: number): void;
  dispose(): void;
}

/** 最近的可用动画名：模型里的命名可能带后缀，这里做前缀匹配。 */
function findClip(clips: THREE.AnimationClip[], name: string): THREE.AnimationClip | null {
  return (
    clips.find((clip) => clip.name === name) ??
    clips.find((clip) => clip.name.startsWith(name)) ??
    null
  );
}

/**
 * 实例化一个角色。
 *
 * `tint` 用于按怪物数据染色，`scale` 用于体现体型差异。
 */
export function createCharacter(
  key: CharacterKey,
  { tint, scale = 1 }: { tint?: string; scale?: number } = {},
): CharacterHandle | null {
  const source = loaded.get(key);
  if (!source) return null;

  const root = new THREE.Group();
  const model = cloneSkinned(source.scene);
  root.add(model);
  root.scale.setScalar(scale);

  // 材质逐个复制：贴图共用，颜色按实例区分，并统一成 Lambert 以贴合现有光照。
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const original = mesh.material as THREE.MeshStandardMaterial | undefined;
    const material = new THREE.MeshLambertMaterial({
      map: original?.map ?? source.map,
      color: tint ? new THREE.Color(tint) : 0xffffff,
    });
    mesh.material = material;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
  });

  const mixer = new THREE.AnimationMixer(model);
  let currentAction: THREE.AnimationAction | null = null;
  let currentName: string | null = null;
  let loopName = 'idle';
  let onceTimeout = 0;

  const play = (name: string, options: { once?: boolean; fade?: number } = {}): void => {
    const { once = false, fade = 0.18 } = options;
    const clip = findClip(source.clips, name);
    if (!clip) return;
    if (!once) loopName = name;
    if (currentName === name) return;
    const next = mixer.clipAction(clip);
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once;
    next.enabled = true;
    next.setEffectiveWeight(1);
    if (currentAction) next.crossFadeFrom(currentAction, fade, false);
    next.play();
    currentAction = next;
    currentName = name;
    onceTimeout = once ? clip.duration : 0;
  };

  play('idle');

  return {
    root,
    play,
    current: () => currentName,
    update(dt: number): void {
      mixer.update(dt);
      // 一次性动作播完回到循环动作。
      if (onceTimeout > 0) {
        onceTimeout -= dt;
        if (onceTimeout <= 0) {
          onceTimeout = 0;
          currentName = null;
          play(loopName, { fade: 0.2 });
        }
      }
    },
    dispose(): void {
      mixer.stopAllAction();
      model.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        (mesh.material as THREE.Material | undefined)?.dispose();
      });
    },
  };
}

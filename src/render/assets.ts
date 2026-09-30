/**
 * 外部模型素材的加载与缓存。
 *
 * 素材来自 Kenney 的 Mini Dungeon 包（CC0），由 `tools/sync-assets.ts` 同步到
 * `public/assets/kenney/`，构建时随产物一起发布。所有模型共用一张调色板贴图，
 * 且已按「一格一个单位、底面在 y=0」对齐，因此无需在运行时缩放或平移。
 *
 * 加载失败时返回 false，渲染层回退到程序化几何体：素材缺失不该让游戏无法启动。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createLogger, LOG_NS } from '../core/log';

/** 素材根路径，相对文档地址。 */
const BASE = 'assets/kenney/';

/** 同步到仓库的模型名，与 `tools/sync-assets.ts` 的清单保持一致。 */
const MODEL_NAMES = ['stairs', 'gate', 'trap'] as const;

type ModelName = (typeof MODEL_NAMES)[number];

const log = createLogger(LOG_NS.render);

const geometries = new Map<ModelName, THREE.BufferGeometry>();
let material: THREE.MeshLambertMaterial | null = null;

/** 取模型几何体；素材未加载时返回 null，调用方据此回退。 */
export function modelGeometry(name: ModelName): THREE.BufferGeometry | null {
  return geometries.get(name) ?? null;
}

/** 共用材质（调色板贴图）。素材未加载时返回 null。 */
export function modelMaterial(): THREE.MeshLambertMaterial | null {
  return material;
}

/** 把模型内部的所有网格合并成一份几何体，减少绘制调用。 */
function mergeParts(root: THREE.Object3D): THREE.BufferGeometry | null {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    // 切线只对法线贴图有意义，本项目的 Lambert 材质用不到。
    geometry.deleteAttribute('tangent');
    geometry.deleteAttribute('uv1');
    parts.push(geometry);
  });
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return mergeGeometries(parts);
}

/**
 * 加载全部模型。返回是否成功；失败时已加载的部分会被清空。
 */
export async function loadModels(): Promise<boolean> {
  try {
    const texture = await new THREE.TextureLoader().loadAsync(`${BASE}Textures/colormap.png`);
    texture.colorSpace = THREE.SRGBColorSpace;
    // 模型来自 glTF，其 UV 约定为 flipY = false；直接用 TextureLoader 加载时
    // 默认值是 true，会让 V 坐标落到图集的空白区域，模型整片发黑。
    texture.flipY = false;
    // 调色板贴图：放大时取最近像素，避免格子之间互相渗色。
    texture.magFilter = THREE.NearestFilter;
    material = new THREE.MeshLambertMaterial({ map: texture });

    const loader = new GLTFLoader();
    const results = await Promise.all(
      MODEL_NAMES.map(async (name) => {
        const gltf = await loader.loadAsync(`${BASE}${name}.glb`);
        return [name, mergeParts(gltf.scene)] as const;
      }),
    );
    for (const [name, geometry] of results) {
      if (!geometry) throw new Error(`模型没有可用几何体：${name}`);
      geometries.set(name, geometry);
    }

    const triangles = [...geometries.values()].reduce(
      (sum, g) => sum + (g.index ? g.index.count : 0) / 3,
      0,
    );
    log.info('模型素材已加载', { models: geometries.size, triangles });
    return true;
  } catch (error) {
    geometries.clear();
    material?.dispose();
    material = null;
    log.warn('模型素材加载失败，回退到程序化几何体', { error: String(error) });
    return false;
  }
}

/** 已加载的模型数量，用于调试与自动化检查。 */
export function loadedModelCount(): number {
  return geometries.size;
}

import * as THREE from 'three';
import { T } from '../core/constants';

/** 地牢主色板：偏暖的石材质感。 */
export const PALETTE = {
  floorRoom: 0x847c6e,
  floorCorr: 0x726b60,
  wall: 0x4c4944,
  wallTop: 0x5b5751,
  doorWood: 0x7a5230,
  doorMetal: 0x8a8f98,
  stairsUp: 0x9aa0a8,
  stairsDown: 0xc9a44c,
  fountainWater: 0x3a7bd5,
  fountainStone: 0x60646c,
  sinkMetal: 0x9aa0a8,
  altarStone: 0x8b8f96,
  altarGlow: 0xb03a3a,
  grave: 0x7b7f86,
  throne: 0x8a6b2f,
  trap: 0x6b2f2f,
  water: 0x2b6a8f,
  lava: 0xd94f1a,
  air: 0x2f3340,
  ice: 0x9fd8e8,
  tree: 0x3f5d34,
  ironbars: 0x555a63,
};

/** 地形瓦片的基础实例颜色。 */
export function tileColor(t: number, _x: number, _y: number): number {
  switch (t) {
    case T.ROOM:
      return PALETTE.floorRoom;
    case T.CORR:
    case T.SCORR:
      return PALETTE.floorCorr;
    case T.VWALL:
    case T.HWALL:
    case T.TLCORNER:
    case T.TRCORNER:
    case T.BLCORNER:
    case T.BRCORNER:
    case T.CROSSWALL:
    case T.TUWALL:
    case T.TDWALL:
    case T.TLWALL:
    case T.TRWALL:
    case T.DBWALL:
      return PALETTE.wall;
    case T.DOOR:
    case T.SDOOR:
      return PALETTE.floorCorr;
    case T.STAIRS:
    case T.LADDER:
      return PALETTE.floorRoom;
    case T.FOUNTAIN:
    case T.SINK:
    case T.ALTAR:
    case T.GRAVE:
    case T.THRONE:
      return PALETTE.floorRoom;
    case T.ICE:
      return PALETTE.ice;
    case T.AIR:
    case T.CLOUD:
      return PALETTE.air;
    case T.POOL:
    case T.MOAT:
    case T.WATER:
      return PALETTE.water;
    case T.LAVA:
      return PALETTE.lava;
    case T.TREE:
      return PALETTE.tree;
    default:
      return PALETTE.floorRoom;
  }
}

/** 确定性瓦片噪声，取值范围 [0, 1)，避免地面颜色完全一致。 */
export function tileNoise(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const REMEMBERED_TINT = new THREE.Color(0x323d52);
export const REMEMBERED_SCALE = 0.42;

/** 取出网格的 Lambert 材质；Group 或材质数组返回 null。 */
export function lambertOf(o: THREE.Object3D): THREE.MeshLambertMaterial | null {
  const material = (o as THREE.Mesh).material;
  if (!material || Array.isArray(material)) return null;
  return material as THREE.MeshLambertMaterial;
}

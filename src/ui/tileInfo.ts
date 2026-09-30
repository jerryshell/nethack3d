/**
 * 光标所指格子的说明文字。
 *
 * 面向鼠标操作：悬停时告诉玩家这是什么、点击会发生什么。
 * 只描述已经探索过的格子，未知区域保持未知。
 */

import type { GameSession } from '../game/session';
import type { Level } from '../types';
import { T, isWalkable, isWall } from '../core/constants';
import { index } from '../game/dungeon';
import { t } from '../i18n/index';
import { monsterName, objectName } from '../data/index';
import { alignDisplayName } from '../data/i18n';
import { describeItem } from '../game/items';
import { woundLevel } from '../game/combat';
import { itemName } from './itemName';

interface TileInfo {
  /** 主要说明，例如怪物名或地形名。 */
  title: string;
  /** 点击后的结果说明。 */
  hint?: string;
  /** 供样式区分的类别。 */
  kind: 'monster' | 'item' | 'stairs' | 'trap' | 'terrain';
}

/** 地形编号到文案键的映射，未列出的按「岩石」处理。 */
const TERRAIN_KEYS: Partial<Record<number, string>> = {
  [T.VWALL]: 'wall',
  [T.HWALL]: 'wall',
  [T.TLCORNER]: 'wall',
  [T.TRCORNER]: 'wall',
  [T.BLCORNER]: 'wall',
  [T.BRCORNER]: 'wall',
  [T.CROSSWALL]: 'wall',
  [T.TUWALL]: 'wall',
  [T.TDWALL]: 'wall',
  [T.TLWALL]: 'wall',
  [T.TRWALL]: 'wall',
  [T.DBWALL]: 'wall',
  [T.TREE]: 'tree',
  [T.SDOOR]: 'door',
  [T.DOOR]: 'door',
  [T.SCORR]: 'corridor',
  [T.CORR]: 'corridor',
  [T.ROOM]: 'room',
  [T.POOL]: 'pool',
  [T.MOAT]: 'moat',
  [T.WATER]: 'water',
  [T.LAVA]: 'lava',
  [T.ICE]: 'ice',
  [T.IRONBARS]: 'ironbars',
  [T.FOUNTAIN]: 'fountain',
  [T.THRONE]: 'throne',
  [T.SINK]: 'sink',
  [T.GRAVE]: 'grave',
  [T.ALTAR]: 'altar',
  [T.STAIRS]: 'stairs',
  [T.LADDER]: 'ladder',
  [T.AIR]: 'air',
  [T.STONE]: 'stone',
};

/** 陷阱编号到文案键的映射（与游戏侧共用）。 */
const TRAP_KEYS: Record<string, string> = {
  ARROW_TRAP: 'arrow',
  DART_TRAP: 'dart',
  ROCKTRAP: 'fallingRock',
  SQKY_BOARD: 'squeakyBoard',
  BEAR_TRAP: 'bearTrap',
  LANDMINE: 'landMine',
  ROLLING_BOULDER_TRAP: 'rollingBoulder',
  SLEEPING_GAS_TRAP: 'sleepingGas',
  RUST_TRAP: 'rust',
  FIRE_TRAP: 'fire',
  PIT: 'pit',
  SPIKED_PIT: 'spikedPit',
  HOLE: 'hole',
  TELEP_TRAP: 'teleport',
  LEVEL_TELEP: 'levelTeleport',
  WEB: 'web',
  STATUE_TRAP: 'statue',
  MAGIC_TRAP: 'magic',
  ANTI_MAGIC: 'antiMagic',
  POLY_TRAP: 'polymorph',
  VIBRATING_SQUARE: 'vibratingSquare',
  MAGIC_PORTAL: 'magicPortal',
};

/** 该格是否已经被玩家看到过。 */
function explored(level: Level, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= level.width || y >= level.height) return false;
  return level.seen[index(x, y)] === 1;
}

/** 攻击提示加上怪物伤势与剩余生命百分比，便于决定要不要硬拼。 */
export function monsterHealthHint(monster: { mhp: number; mhpmax: number }): string {
  const pct = monster.mhpmax > 0 ? Math.ceil((monster.mhp / monster.mhpmax) * 100) : 100;
  const key = {
    unhurt: 'tile.healthUnhurt',
    light: 'tile.healthLight',
    heavy: 'tile.healthHeavy',
    nearDeath: 'tile.healthNearDeath',
  }[woundLevel(monster.mhp, monster.mhpmax)];
  return `${t('tile.attackHint')} · ${t(key, { n: pct })}`;
}

/**
 * 描述一格。未探索或超出地图返回 null。
 */
export function describeTile(session: GameSession, x: number, y: number): TileInfo | null {
  const level = session.level;
  if (!explored(level, x, y)) return null;
  const i = index(x, y);

  const monster = level.monsters.find((m) => m.x === x && m.y === y && m.mhp > 0);
  if (monster) {
    // 伪装的拟形怪只显示成它伪装的东西，撞上去才会现形，不暴露伤势。
    if (monster.disguise) {
      return { title: objectName(monster.disguise), hint: t('tile.attackHint'), kind: 'monster' };
    }
    return {
      title: monsterName(monster.data.id),
      hint: monsterHealthHint(monster),
      kind: 'monster',
    };
  }

  const pile = level.objects.find((p) => p.x === x && p.y === y && p.items.length > 0);
  if (pile) {
    const names = pile.items.slice(0, 3).map((item) => itemName(describeItem(item)));
    const rest = pile.items.length - names.length;
    return {
      title: rest > 0 ? `${names.join('、')} · ${t('tile.more', { n: rest })}` : names.join('、'),
      hint: t('tile.pickupHint'),
      kind: 'item',
    };
  }

  const stair = level.stairs.find((s) => s.x === x && s.y === y);
  if (stair) {
    if (stair.dir === 'branch') {
      return {
        title: t('tile.branchStairs', { branch: t(`branch.${stair.branch ?? 'main'}`) }),
        hint: t('tile.branchHint'),
        kind: 'stairs',
      };
    }
    return {
      title: t(stair.dir === 'down' ? 'tile.stairsDown' : 'tile.stairsUp'),
      hint: stair.dir === 'down' ? t('tile.descendHint') : t('tile.ascendHint'),
      kind: 'stairs',
    };
  }

  const trap = level.traps.get(i);
  if (trap) {
    const key = TRAP_KEYS[trap.type];
    return {
      title: key ? t(`trap.${key}`) : trap.type,
      hint: t('tile.trapHint'),
      kind: 'trap',
    };
  }

  const feature = level.features.get(i);
  if (feature) {
    const key = TERRAIN_KEYS[level.tiles[i]] ?? 'stone';
    const base = t(`terrain.${key}`);
    // 祭坛标出归属，方便玩家判断该不该在这里祈祷。
    const title = feature.align
      ? t('terrain.aligned', { terrain: base, align: alignDisplayName(feature.align) })
      : base;
    return { title, hint: t('tile.featureHint'), kind: 'terrain' };
  }

  const tile = level.tiles[i];
  const key = TERRAIN_KEYS[tile] ?? 'stone';
  const digger = ['PICK_AXE', 'DWARVISH_MATTOCK'].includes(session.player.weapon?.id ?? '');
  return {
    title: t(`terrain.${key}`),
    // 可行走的地面要点明「可以点」，这是鼠标移动的入口；
    // 持镐时提示墙壁可以挖。
    hint: isWalkable(tile)
      ? t('tile.walkHint')
      : digger && isWall(tile)
        ? t('tile.digHint')
        : undefined,
    kind: 'terrain',
  };
}

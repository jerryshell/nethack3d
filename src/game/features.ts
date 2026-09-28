/**
 * 地形设施的效果表：喷泉、水槽、坟墓、王座。
 *
 * 与陷阱表同构：每种设施的效果归到少数几种类型，会话层按类型执行，
 * 因此新增效果只是往表里加一行。权重之和不必凑整，抽取按相对权重。
 *
 * 祭坛留到祈祷与阵营记录落地后再启用，目前只作为陈设，
 * 边界记录在 docs/COGNITION.md。
 */

import type { Rng } from '../types';
import { T } from '../core/constants';

/** 设施种类。 */
export type FeatureKind = 'fountain' | 'sink' | 'grave' | 'throne';

/** 玩家可以对设施做的动作。 */
export type FeatureAction = 'drink' | 'kick' | 'dig' | 'sit';

/** 效果类型。 */
export type FeatureEffectKind =
  | 'nothing'
  | 'heal'
  | 'refresh'
  | 'seeInvisible'
  | 'luck'
  | 'strength'
  | 'gold'
  | 'item'
  | 'wake'
  | 'damage'
  | 'curse'
  | 'dry'
  | 'break'
  | 'vanish'
  | 'spawn';

export interface FeatureEffect {
  kind: FeatureEffectKind;
  /** 相对权重。 */
  weight: number;
  /** 提示文案键。 */
  message: string;
  /** 伤害或治疗的骰子：`[个数, 面数]`。 */
  dice?: [number, number];
  /** `spawn` 类效果现身的怪物 id。 */
  monster?: string;
  /** 效果结束后设施失效：喷泉干涸、水槽损坏、坟墓挖开、王座消失。 */
  depletes?: boolean;
}

/** 喷泉：喝水，对应原版 fountain.c 的常见结果。 */
const FOUNTAIN: FeatureEffect[] = [
  { kind: 'nothing', weight: 24, message: 'msg.fountainNothing' },
  { kind: 'heal', weight: 16, dice: [2, 8], message: 'msg.fountainHeal' },
  { kind: 'refresh', weight: 12, dice: [2, 6], message: 'msg.fountainRefresh' },
  { kind: 'nothing', weight: 10, message: 'msg.fountainBadTaste' },
  { kind: 'dry', weight: 10, depletes: true, message: 'msg.fountainDries' },
  { kind: 'seeInvisible', weight: 5, message: 'msg.fountainSeeInvisible' },
  { kind: 'luck', weight: 5, message: 'msg.fountainLuck' },
  { kind: 'spawn', weight: 4, monster: 'WATER_DEMON', message: 'msg.fountainDemon' },
  { kind: 'spawn', weight: 4, monster: 'WATER_MOCCASIN', message: 'msg.fountainSnake' },
  { kind: 'strength', weight: 1, message: 'msg.fountainStrength' },
];

/** 水槽：踹一脚，对应原版 kick.c 的水槽分支。 */
const SINK: FeatureEffect[] = [
  { kind: 'nothing', weight: 22, message: 'msg.sinkRattles' },
  { kind: 'nothing', weight: 18, message: 'msg.sinkSplash' },
  { kind: 'item', weight: 12, message: 'msg.sinkItem' },
  { kind: 'break', weight: 12, depletes: true, message: 'msg.sinkBreaks' },
  { kind: 'wake', weight: 10, message: 'msg.sinkNoise' },
  { kind: 'spawn', weight: 6, monster: 'BLACK_PUDDING', message: 'msg.sinkPudding' },
];

/** 坟墓：挖开一次，之后只剩泥土。 */
const GRAVE: FeatureEffect[] = [
  { kind: 'nothing', weight: 30, depletes: true, message: 'msg.graveEmpty' },
  { kind: 'spawn', weight: 16, depletes: true, monster: 'GHOUL', message: 'msg.graveUndead' },
  { kind: 'gold', weight: 14, depletes: true, message: 'msg.graveGold' },
  { kind: 'curse', weight: 8, depletes: true, message: 'msg.graveCurse' },
  { kind: 'item', weight: 8, depletes: true, message: 'msg.graveItem' },
];

/** 王座：坐上去，对应原版 sit.c 的随机结果；坐过一次后不再有效。 */
const THRONE: FeatureEffect[] = [
  { kind: 'nothing', weight: 18, message: 'msg.throneNothing' },
  { kind: 'heal', weight: 14, dice: [4, 6], message: 'msg.throneHeal' },
  { kind: 'refresh', weight: 12, dice: [3, 6], message: 'msg.throneRefresh' },
  { kind: 'gold', weight: 12, message: 'msg.throneGold' },
  { kind: 'vanish', weight: 10, depletes: true, message: 'msg.throneVanish' },
  { kind: 'damage', weight: 10, dice: [2, 6], message: 'msg.throneShock' },
  { kind: 'strength', weight: 8, message: 'msg.throneStrength' },
  { kind: 'wake', weight: 8, message: 'msg.throneWake' },
  { kind: 'item', weight: 6, message: 'msg.throneItem' },
];

export const FEATURE_TABLES: Record<FeatureKind, FeatureEffect[]> = {
  fountain: FOUNTAIN,
  sink: SINK,
  grave: GRAVE,
  throne: THRONE,
};

/** 按权重抽取一次效果。 */
export function rollFeatureEffect(rng: Rng, kind: FeatureKind): FeatureEffect {
  return rng.pickWeighted(FEATURE_TABLES[kind], 'weight') as FeatureEffect;
}

/** 玩家站上设施时界面提供的动作。 */
export interface FeatureActionDef {
  id: string;
  action: FeatureAction;
  kind: FeatureKind;
  labelKey: string;
  hintKey: string;
}

/** 瓦片类型到情境动作的定义，未列出的设施（祭坛）没有动作。 */
export const FEATURE_ACTIONS: Partial<Record<number, FeatureActionDef>> = {
  [T.FOUNTAIN]: {
    id: 'drink',
    action: 'drink',
    kind: 'fountain',
    labelKey: 'actions.drink',
    hintKey: 'actionHints.drink',
  },
  [T.SINK]: {
    id: 'kick',
    action: 'kick',
    kind: 'sink',
    labelKey: 'actions.kick',
    hintKey: 'actionHints.kick',
  },
  [T.GRAVE]: {
    id: 'dig',
    action: 'dig',
    kind: 'grave',
    labelKey: 'actions.dig',
    hintKey: 'actionHints.dig',
  },
  [T.THRONE]: {
    id: 'sit',
    action: 'sit',
    kind: 'throne',
    labelKey: 'actions.sit',
    hintKey: 'actionHints.sit',
  },
};

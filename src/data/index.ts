/**
 * 游戏数据访问层。
 *
 * 包装由提取脚本生成的数据模块（monsters.gen.ts / objects.gen.ts），
 * 提供快速查找、按类别分组、生成权重，以及 NetHack 的未鉴定外观洗牌
 * （药水、卷轴、魔杖、戒指、护身符、法术书、宝石）。
 *
 * 中文名称存放在 src/data/i18n.zh.ts，通过 `monsterName()` 与
 * `objectName()` 查询，缺失时回退英文。
 */

import type { MonsterData, ObjectData } from '../types';
import type { Rng } from '../types';
import { MONSTERS } from './monsters.gen';
import { OBJECTS } from './objects.gen';

export { MONSTERS, OBJECTS };

export const monById = new Map<string, MonsterData>(MONSTERS.map((m) => [m.id, m]));
export const objById = new Map<string, ObjectData>(OBJECTS.map((o) => [o.id, o]));

/** 真实物品，排除只用于补齐外观池的占位条目。 */
export const REAL_OBJECTS: ObjectData[] = OBJECTS.filter((o) => !o.dummy);

/** 可在普通关卡随机生成的怪物。 */
export const GENERATABLE_MONSTERS: MonsterData[] = MONSTERS.filter(
  (m) => !m.genFlags.includes('G_NOGEN') && m.freq > 0,
);

/**
 * 未鉴定外观洗牌，等价于 NetHack 的 `shuffle_all()`。
 *
 * 每个需要随机外观的类别中，条目与描述一一对应，洗牌后重新分配。
 * 魔杖包含三个占位条目，因此有 3 个描述不会被使用，
 * 与 NetHack 中「25 根魔杖对应 28 种外观」的行为一致。
 *
 * 返回「物品 ID → 外观字符串」的映射。
 */
export function shuffleAppearances(rng: Rng): Map<string, string> {
  const result = new Map<string, string>();
  const byClass = new Map<string, ObjectData[]>();
  for (const o of OBJECTS) {
    if (!o.appr) continue;
    const list = byClass.get(o.cls);
    if (list) list.push(o);
    else byClass.set(o.cls, [o]);
  }
  for (const [, group] of byClass) {
    const descs = rng.shuffle(group.map((o) => o.appr as string));
    // 描述按顺序发给真实条目；占位条目会消耗掉多余的描述。
    const real = group.filter((o) => !o.dummy);
    const pool = descs.slice();
    for (let i = 0; i < real.length && pool.length; i++) {
      result.set(real[i].id, pool[i]);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 名称本地化
// ---------------------------------------------------------------------------

type NameMap = Map<string, string>;

let nameOverrides: { monsters: NameMap; objects: NameMap } = {
  monsters: new Map(),
  objects: new Map(),
};

/** 安装或替换当前生效的翻译映射。 */
export function setNameOverrides(overrides: {
  monsters?: NameMap | Record<string, string>;
  objects?: NameMap | Record<string, string>;
}): void {
  const toMap = (value: NameMap | Record<string, string> | undefined): NameMap =>
    value instanceof Map ? value : new Map(Object.entries(value ?? {}));
  nameOverrides = {
    monsters: toMap(overrides.monsters),
    objects: toMap(overrides.objects),
  };
}

/** 怪物显示名，接受 ID 或怪物数据。 */
export function monsterName(m: string | MonsterData): string {
  if (typeof m === 'string') return nameOverrides.monsters.get(m) ?? monById.get(m)?.name ?? m;
  return nameOverrides.monsters.get(m.id) ?? m.name;
}

/** 物品显示名，接受 ID 或物品数据。 */
export function objectName(o: string | ObjectData): string {
  if (typeof o === 'string') return nameOverrides.objects.get(o) ?? objById.get(o)?.name ?? o;
  return nameOverrides.objects.get(o.id) ?? o.name ?? o.id;
}

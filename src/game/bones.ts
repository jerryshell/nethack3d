/**
 * 骨头文件：上一局玩家死亡后留在原地的一堆遗物。
 *
 * 只保留最近一份，进入对应深度的楼层时把物品放回地面，并让幽灵看守；
 * 取出后清空，避免同层反复出现。浏览器用 localStorage 持久化，
 * 测试环境退回进程内存，接口一致。
 */

import type { SerializedItem } from '../types';
import { createLogger, LOG_NS } from '../core/log';
import { serializeItem } from './itemcodec';
import type { GameSession } from './session';

const log = createLogger(LOG_NS.save);

const BONES_KEY = 'nethack3d.bones.v1';

interface Bones {
  /** 死亡所在层数。 */
  depth: number;
  /** 死亡角色，供调试与文案使用。 */
  roleId: string;
  /** 死亡时的回合数。 */
  turn: number;
  /** 遗物。 */
  inventory: SerializedItem[];
}

/** 简单存储接口：浏览器用 localStorage，测试环境退回内存。 */
interface BonesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memory = new Map<string, string>();

function storage(): BonesStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* 无 localStorage：用内存 */
  }
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value);
    },
    removeItem: (key) => {
      memory.delete(key);
    },
  };
}

/** 玩家死亡时记录现场，供下一局在同一深度发现遗物。 */
export function saveBones(session: GameSession): void {
  const bones: Bones = {
    depth: session.depth,
    roleId: session.player.role.id,
    turn: session.turn,
    inventory: session.player.inventory.map(serializeItem),
  };
  try {
    storage().setItem(BONES_KEY, JSON.stringify(bones));
    log.info('骨头文件已写入', { depth: bones.depth, items: bones.inventory.length });
  } catch (err) {
    log.warn('骨头文件写入失败', err);
  }
}

/** 读取骨头文件；没有或损坏时返回 null。 */
export function loadBones(): Bones | null {
  let raw: string | null = null;
  try {
    raw = storage().getItem(BONES_KEY);
  } catch (err) {
    log.warn('骨头文件读取失败', err);
    return null;
  }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Bones;
    if (typeof data?.depth !== 'number' || !Array.isArray(data.inventory)) return null;
    return data;
  } catch (err) {
    log.warn('骨头文件解析失败，已忽略', err);
    return null;
  }
}

export function clearBones(): void {
  try {
    storage().removeItem(BONES_KEY);
  } catch {
    /* ignore */
  }
}

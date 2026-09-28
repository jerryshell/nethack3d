/**
 * 状态转储：把当前会话与最近的日志整理成纯文本，方便附在问题反馈里。
 *
 * 输出分两段：
 *
 * 1. 人读部分。种子、层数、回合在前几行，地图用 ASCII，实体带坐标与原始 ID。
 * 2. 存档 JSON。由 `serializeSession` 生成，可以原样写回 localStorage
 *    （键 `nethack3d.save.v1`）恢复现场，做到不依赖操作回放。
 */

import type { ItemInstance } from '../types';
import type { GameSession } from '../game/session';
import { MAX_DEPTH } from '../game/session';
import { sessionAscii } from '../game/ascii';
import { serializeSession } from '../game/save';
import { describeItem } from '../game/items';
import { monsterName } from '../data/index';
import { dumpLogs } from '../core/log';
import { getLocale } from '../i18n/index';
import { itemName, itemSuffix } from './itemName';
import { formatMessage } from './message';

/** 存档 JSON 的分隔标记；测试与工具据此截取载荷。 */
export const DUMP_SAVE_MARKER = '--- save json ---';

/** 物品一行：显示名加原型 ID、数量与鉴定状态，便于机器核对。 */
function itemLine(item: ItemInstance, equipped: string | null = null): string {
  const bits = [`${itemName(describeItem(item))}${itemSuffix(item, { equipped })}`];
  bits.push(`id=${item.id}`);
  if (item.quantity > 1) bits.push(`x${item.quantity}`);
  if (!item.known) bits.push('unidentified');
  return bits.join('  ');
}

/** 生成可复制的状态转储文本。 */
export function buildDump(session: GameSession): string {
  const p = session.player;
  const level = session.level;
  const s = session.status;
  const lines: string[] = [];

  lines.push('=== NetHack 3D 状态转储 ===');
  lines.push(`generatedAt: ${new Date().toISOString()}`);
  lines.push(`locale: ${getLocale()}`);
  lines.push('');
  lines.push(`seed: ${session.seed}`);
  lines.push(
    session.branch === 'main'
      ? `depth: ${session.depth} / ${MAX_DEPTH}`
      : `depth: ${session.branch} ${session.depth} / ${session.maxDepth}`,
  );
  lines.push(`turn: ${session.turn}`);
  lines.push(`kills: ${session.kills}`);
  lines.push(`dead: ${session.dead ? 1 : 0}`);
  lines.push(`character: ${s.role} / ${s.race} / ${s.align} / ${p.gender}`);
  lines.push(`position: ${p.x},${p.y}`);
  lines.push(
    `hp: ${s.hp}/${s.maxHp}  pw: ${s.pw}/${s.maxPw}  ac: ${s.ac}  level: ${s.level}  xp: ${s.xp}`,
  );
  lines.push(`gold: ${s.gold}  hunger: ${p.hunger}  luck: ${p.luck}`);
  lines.push(`align: ${p.align} record=${p.alignRecord ?? 0} prayer=${p.prayerTimeout ?? 0}`);
  lines.push(`form: ${p.form ? `${p.form.id}(${p.form.turns})` : '-'}`);
  const skills = Object.entries(p.skillLevels ?? {}).filter(([, lv]) => lv > 0);
  lines.push(`skills: ${skills.length ? skills.map(([k, lv]) => `${k}=${lv}`).join(' ') : '-'}`);
  lines.push(
    `effects: blind=${p.blind ?? 0} confused=${p.confused ?? 0} invisible=${p.invisible ?? 0} ` +
      `sleep=${p.sleep ?? 0} held=${p.held ?? 0} stun=${p.stun ?? 0} ` +
      `petrifying=${p.petrifying ?? 0} seeInvisible=${p.seeInvisible ? 1 : 0}`,
  );

  lines.push('');
  lines.push('equipment:');
  const slots = Object.entries(p.equipment).filter(([, item]) => item);
  if (!slots.length) lines.push('  (none)');
  for (const [slot, item] of slots) lines.push(`  ${slot}: ${itemLine(item as ItemInstance)}`);
  lines.push('inventory:');
  if (!p.inventory.length) lines.push('  (empty)');
  else {
    p.inventory.forEach((item, index) => {
      const slot = slots.find(([, equipped]) => equipped === item)?.[0] ?? null;
      lines.push(`  ${index + 1}. ${itemLine(item, slot)}`);
    });
  }

  lines.push('');
  lines.push('level:');
  lines.push(
    `  rooms: ${level.rooms.length}  doors: ${level.doors.size}  traps: ${level.traps.size}  ` +
      `features: ${level.features.size}  piles: ${level.objects.length}  special: ${level.special ?? '-'}`,
  );
  const stairs = level.stairs.map((stair) => `${stair.dir}(${stair.x},${stair.y})`).join(' ');
  lines.push(`  stairs: ${stairs || '-'}`);
  const doorStates = [...level.doors.values()];
  lines.push(
    `  door states: closed=${doorStates.filter((d) => d.closed).length} ` +
      `locked=${doorStates.filter((d) => d.locked).length} ` +
      `broken=${doorStates.filter((d) => d.broken).length}`,
  );
  lines.push(`  monsters (${level.monsters.length}):`);
  for (const mon of level.monsters) {
    lines.push(
      `    - ${monsterName(mon.data.id)} (${mon.data.id}) at ${mon.x},${mon.y} ` +
        `hp ${mon.mhp}/${mon.mhpmax} mv ${mon.mv} asleep=${mon.asleep ? 1 : 0} ` +
        `fleeing=${mon.fleeing ? 1 : 0} dead=${mon.dead ? 1 : 0}`,
    );
  }
  lines.push(`  piles (${level.objects.length}):`);
  for (const pile of level.objects) {
    const items = pile.items.map((item) => itemName(describeItem(item))).join('; ');
    lines.push(`    - at ${pile.x},${pile.y}: ${items}`);
  }
  lines.push(`  traps (${level.traps.size}):`);
  for (const [tile, trap] of level.traps) {
    lines.push(
      `    - at ${tile % level.width},${Math.floor(tile / level.width)} ${trap.type} seen=${trap.seen ? 1 : 0}`,
    );
  }

  lines.push('');
  lines.push('map:');
  lines.push(sessionAscii(session));

  lines.push('');
  lines.push(`messages (last ${Math.min(12, session.messages.length)}):`);
  for (const message of session.messages.slice(-12)) lines.push(`  ${formatMessage(message)}`);

  lines.push('');
  lines.push('logs:');
  const logs = dumpLogs(150);
  lines.push(logs || '  (empty)');

  lines.push('');
  lines.push(DUMP_SAVE_MARKER);
  lines.push(JSON.stringify(serializeSession(session)));
  return `${lines.join('\n')}\n`;
}

/** 转储文件名：带层数、种子与回合，放一起也不会混淆。 */
export function dumpFileName(session: GameSession): string {
  return `nethack3d-d${session.depth}-seed${session.seed}-turn${session.turn}.txt`;
}

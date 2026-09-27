# -*- coding: utf-8 -*-
"""接入陷阱结算、睡眠与定身状态。"""

import io

p = 'src/game/session.ts'
s = io.open(p, encoding='utf-8').read()

# 1) 导入
old = "import { randomTrapTypes } from '../core/constants';"
if old not in s:
    # 常量从 dungeon 里引入的情况，退回到按需插入
    old = None
anchor = "import type { GroundPile"
assert anchor in s
s = s.replace(anchor, "import { trapEffect, trapNameKey } from './traps';\nimport type { GroundPile", 1)

# 2) 睡眠/定身门控 + 陷阱结算
old = """  movePlayer(dx: number, dy: number): ActionResultInfo {
    if (this.dead) return { result: 'dead' };"""
new = """  movePlayer(dx: number, dy: number): ActionResultInfo {
    if (this.dead) return { result: 'dead' };
    // 沉睡时无法行动，但回合照样流逝。
    if (this.player.sleep > 0) {
      this.log('msg.asleep');
      this.finishTurn();
      return { result: 'slept' };
    }
    // 被缠住时无法移动，其它动作不受影响。
    if (this.player.held > 0) {
      this.log('msg.held');
      this.finishTurn();
      return { result: 'held' };
    }"""
assert old in s
s = s.replace(old, new, 1)

old = """    const gold = autoPickupGold(this.player, this.level);
    if (gold > 0) this.log('msg.gold', { n: gold });
    this.refreshFov();"""
new = """    const gold = autoPickupGold(this.player, this.level);
    if (gold > 0) this.log('msg.gold', { n: gold });
    this.refreshFov();

    // 踩中陷阱：可能受伤、被传走或掉到下一层。
    const teleported = this.springTrap(index(nx, ny));
    if (this.dead) return { result: 'dead' };
    if (teleported) {
      // 已经不在原格，楼梯判定失去意义。
      this.finishTurn();
      return { result: 'moved' };
    }"""
assert old in s
s = s.replace(old, new, 1)

# 3) 陷阱结算方法：插在 upkeep 之前
old = """  upkeep(): void {"""
new = """  /**
   * 结算踩中的陷阱。
   *
   * 返回是否发生了位移或换层：位移之后调用方不应再按原格判断楼梯。
   */
  springTrap(tile: number): boolean {
    const trap = this.level.traps.get(tile);
    if (!trap) return false;
    const effect = trapEffect(trap.type);
    const trapName = trapNameKey(trap.type);
    trap.seen = true;
    let moved = false;

    switch (effect.kind) {
      case 'damage':
      case 'hold': {
        if (effect.dice) {
          const dmg = this.rng.dice(effect.dice[0], effect.dice[1]);
          this.log(effect.message, { trap: trapName, n: dmg });
          const died = this.player.takeDamage(dmg);
          if (died) {
            this.dead = true;
            return false;
          }
        } else {
          this.log(effect.message, { trap: trapName });
        }
        if (effect.kind === 'hold') {
          this.player.held = Math.max(this.player.held, effect.turns ?? 2);
        }
        break;
      }
      case 'sleep': {
        this.log(effect.message, { trap: trapName });
        this.player.sleep = Math.max(this.player.sleep, effect.turns ?? 3);
        break;
      }
      case 'drainPw': {
        const drained = this.player.pw;
        this.player.pw = 0;
        this.log(effect.message, { trap: trapName, n: drained });
        break;
      }
      case 'wake': {
        this.log(effect.message, { trap: trapName });
        for (const mon of this.level.monsters) mon.asleep = false;
        break;
      }
      case 'rust': {
        const suit = this.player.equipment.suit;
        if (suit && suit.enchant > -5) {
          suit.enchant--;
          this.log(effect.message, { trap: trapName, item: suit.proto.id });
        } else {
          this.log('msg.trapRustNoArmor', { trap: trapName });
        }
        break;
      }
      case 'teleport': {
        const spot = this.randomFloorTile();
        if (spot) {
          this.player.x = spot.x;
          this.player.y = spot.y;
          this.refreshFov();
          moved = true;
        }
        this.log(effect.message, { trap: trapName });
        break;
      }
      case 'levelTeleport': {
        const delta = this.rng.rn2(3) - 1 || 1;
        const target = Math.max(1, Math.min(MAX_DEPTH, this.depth + delta));
        this.log(effect.message, { trap: trapName, depth: target });
        this.changeDepth(target, target > this.depth ? 'down' : 'up');
        moved = true;
        break;
      }
      case 'hole': {
        if (this.depth < MAX_DEPTH) {
          this.log(effect.message, { trap: trapName });
          this.changeDepth(this.depth + 1, 'down');
          moved = true;
        } else {
          this.log('msg.trapFlavor', { trap: trapName });
        }
        break;
      }
      case 'magic': {
        // 魔法陷阱效果随机：伤害、恢复、抽干法力或传送。
        const roll = this.rng.rn2(4);
        if (roll === 0) {
          const dmg = this.rng.dice(1, 8);
          this.log('msg.trapDamage', { trap: trapName, n: dmg });
          if (this.player.takeDamage(dmg)) {
            this.dead = true;
            return false;
          }
        } else if (roll === 1) {
          this.player.hp = this.player.maxHp;
          this.log('msg.trapMagicHeal');
        } else if (roll === 2) {
          const drained = this.player.pw;
          this.player.pw = 0;
          this.log('msg.trapDrainPw', { trap: trapName, n: drained });
        } else {
          const spot = this.randomFloorTile();
          if (spot) {
            this.player.x = spot.x;
            this.player.y = spot.y;
            this.refreshFov();
            moved = true;
          }
          this.log('msg.trapTeleport', { trap: trapName });
        }
        break;
      }
      default: {
        this.log(effect.message, { trap: trapName });
        break;
      }
    }
    return moved;
  }

  /** 随机挑一个可站立的地面格，用于传送类效果。 */
  randomFloorTile(): { x: number; y: number } | null {
    const candidates: number[] = [];
    for (let i = 0; i < this.level.tiles.length; i++) {
      const t = this.level.tiles[i];
      if (t === T.ROOM || t === T.CORR) candidates.push(i);
    }
    if (!candidates.length) return null;
    const pick = candidates[this.rng.rn2(candidates.length)];
    return { x: pick % COLNO, y: Math.floor(pick / COLNO) };
  }

  upkeep(): void {"""
assert old in s
s = s.replace(old, new, 1)

# 4) upkeep：递减新状态
old = """    if (p.confused > 0) p.confused--;"""
new = """    if (p.confused > 0) p.confused--;
    if (p.sleep > 0) {
      p.sleep--;
      if (p.sleep === 0) this.log('msg.wakesUp');
    }
    if (p.held > 0) {
      p.held--;
      if (p.held === 0) this.log('msg.freeFromTrap');
    }"""
assert old in s
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('session.ts：陷阱与状态已接入')

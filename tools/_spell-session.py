# -*- coding: utf-8 -*-
"""接入施法系统。"""

import io

p = 'src/game/session.ts'
s = io.open(p, encoding='utf-8').read()

# 1) 导入
old = "import { trapEffect, trapNameKey } from './traps';"
new = "import { trapEffect, trapNameKey } from './traps';\nimport { castFailChance, rollSpellAmount, spellProfile } from './spells';"
assert old in s
s = s.replace(old, new, 1)

# 2) 把击杀结算抽成方法，攻击与法术共用
old = """    if (mon.mhp <= 0) {
      mon.dead = true;
      this.kills++;
      const xp = killExperience(mon);
      log.info('怪物被击杀', {
        monster: mon.data.id,
        xp,
        monsterLevel: mon.mlev,
        depth: this.depth,
      });
      this.log('msg.youKill', { mon: mon.data.id });
      this.lastCombat = { monsterId: mon.id, hit: true, byPlayer: true, killed: true };
      player.gainXp(xp, this.rng, (level: number) => {
        this.log('msg.levelUp', { level });
      });
      // 怪物死亡时有概率留下金币。
      if (this.rng.chance(0.35)) {
        const pile = pileAt(this.level, mon.x, mon.y);
        const gold = makeGold(this.rng, this.depth);
        if (pile) pile.items.push(gold);
        else this.level.objects.push({ x: mon.x, y: mon.y, items: [gold] });
      }
      return 'killed';
    }
    return 'attacked';
  }"""
new = """    if (mon.mhp <= 0) {
      this.slayMonster(mon, true);
      return 'killed';
    }
    return 'attacked';
  }

  /**
   * 结算一只怪物的死亡：经验、击杀计数与掉落。
   *
   * 近战与法术共用，避免两处各写一份。
   */
  slayMonster(mon: Monster, byPlayer = true): void {
    if (mon.dead) return;
    mon.dead = true;
    this.kills++;
    const xp = killExperience(mon);
    log.info('怪物被击杀', {
      monster: mon.data.id,
      xp,
      monsterLevel: mon.mlev,
      depth: this.depth,
    });
    this.log('msg.youKill', { mon: mon.data.id });
    if (byPlayer) {
      this.lastCombat = { monsterId: mon.id, hit: true, byPlayer: true, killed: true };
    }
    this.player.gainXp(xp, this.rng, (level: number) => {
      this.log('msg.levelUp', { level });
    });
    // 怪物死亡时有概率留下金币。
    if (this.rng.chance(0.35)) {
      const pile = pileAt(this.level, mon.x, mon.y);
      const gold = makeGold(this.rng, this.depth);
      if (pile) pile.items.push(gold);
      else this.level.objects.push({ x: mon.x, y: mon.y, items: [gold] });
    }
  }

  /** 视野范围内最近的怪物，用于需要选目标的法术。 */
  nearestMonster(maxDistance = 8): Monster | null {
    let best: Monster | null = null;
    let bestDistance = maxDistance + 1;
    for (const mon of this.level.monsters) {
      if (mon.mhp <= 0) continue;
      const dist = Math.max(Math.abs(mon.x - this.player.x), Math.abs(mon.y - this.player.y));
      if (dist < bestDistance) {
        bestDistance = dist;
        best = mon;
      }
    }
    return best;
  }

  /** 该怪物是否属于不死生物。 */
  isUndead(mon: Monster): boolean {
    return mon.data.flags.some((flag) => flag.includes('UNDEAD'));
  }

  /**
   * 施放已知法术。
   *
   * 代价等于法术等级；失败时按原版规则损失一半法力。
   * 法力不足时不消耗回合，避免玩家白白空过。
   */
  castSpell(item: ItemInstance): ActionResultInfo {
    if (this.dead || !item) return { result: 'nothing' };
    const proto = item.proto;
    const profile = spellProfile(proto);
    const level = proto.level ?? 1;
    const known = (this.player.knownSpells ?? []).includes(proto.id);
    if (!known) {
      this.log('msg.castUnknown', { obj: proto.id });
      this.finishTurn();
      return { result: 'used', key: 'msg.castUnknown' };
    }
    if (this.player.pw < profile.cost) {
      this.log('msg.castNoMana', { need: profile.cost, pw: this.player.pw });
      return { result: 'nothing' };
    }

    if (this.rng.chance(castFailChance(this.player, level))) {
      const lost = Math.max(1, Math.ceil(profile.cost / 2));
      this.player.pw = Math.max(0, this.player.pw - lost);
      this.log('msg.castFail', { n: lost });
      this.finishTurn();
      return { result: 'used', key: 'msg.castFail' };
    }
    this.player.pw -= profile.cost;

    let key = 'msg.castNothing';
    const vars: Record<string, string | number> = { obj: proto.id };
    switch (profile.kind) {
      case 'attack': {
        const target = this.nearestMonster(8);
        if (!target) {
          key = 'msg.castNoTarget';
          break;
        }
        const amount = rollSpellAmount(this.rng, profile);
        target.mhp -= amount;
        this.lastCombat = { monsterId: target.id, hit: true, byPlayer: true, damage: amount };
        vars.mon = target.data.id;
        vars.dmg = amount;
        key = 'msg.castHit';
        if (target.mhp <= 0) this.slayMonster(target);
        break;
      }
      case 'heal': {
        const amount = rollSpellAmount(this.rng, profile);
        const before = this.player.hp;
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + amount);
        vars.n = this.player.hp - before;
        key = 'msg.castHeal';
        break;
      }
      case 'divine': {
        // 祛邪：优先打不死生物，没有目标时给自己一点治疗。
        const undead = this.level.monsters.find(
          (mon) => mon.mhp > 0 && this.isUndead(mon) && this.nearestMonster(8)?.id === mon.id,
        );
        if (undead) {
          const amount = rollSpellAmount(this.rng, profile) * 2;
          undead.mhp -= amount;
          vars.mon = undead.data.id;
          vars.dmg = amount;
          key = 'msg.castTurnUndead';
          if (undead.mhp <= 0) this.slayMonster(undead);
        } else {
          this.player.hp = Math.min(this.player.maxHp, this.player.hp + 1);
          key = 'msg.castDivineBless';
        }
        break;
      }
      case 'detect': {
        this.revealLevel();
        key = 'msg.castDetect';
        break;
      }
      case 'enchant': {
        const target = this.nearestMonster(8);
        if (!target) {
          key = 'msg.castNoTarget';
          break;
        }
        target.asleep = true;
        vars.mon = target.data.id;
        key = 'msg.castSleep';
        break;
      }
      case 'escape': {
        const spot = this.randomFloorTile();
        if (spot) {
          this.player.x = spot.x;
          this.player.y = spot.y;
          this.refreshFov();
        }
        key = 'msg.castEscape';
        break;
      }
      case 'matter': {
        // 物质法术：打开附近的门；没有门就把相邻的墙化为地面。
        let opened = false;
        for (const [i, door] of this.level.doors) {
          if (!door.closed) continue;
          const x = i % COLNO;
          const y = Math.floor(i / COLNO);
          if (Math.max(Math.abs(x - this.player.x), Math.abs(y - this.player.y)) > 8) continue;
          door.closed = false;
          door.locked = false;
          opened = true;
          break;
        }
        key = opened ? 'msg.castKnock' : 'msg.castMatterNothing';
        break;
      }
      default: {
        key = 'msg.castNothing';
        break;
      }
    }

    this.log(key, vars);
    this.finishTurn();
    return { result: 'used', key };
  }"""
assert old in s
s = s.replace(old, new, 1)

# 3) useItem 支持 cast 动词
old = """      case 'drop': {
        const res = dropItem(this.player, this.level, item);
        outcome = { key: 'use.drop', vars: { item: describeItem(res.item) } };
        break;
      }"""
new = """      case 'drop': {
        const res = dropItem(this.player, this.level, item);
        outcome = { key: 'use.drop', vars: { item: describeItem(res.item) } };
        break;
      }
      case 'cast': {
        // 施法自带结算与回合推进，直接返回。
        return this.castSpell(item);
      }"""
assert old in s
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('session.ts：施法已接入')

# 4) 背包动作：已知法术可施展
p = 'src/game/inventory.ts'
s = io.open(p, encoding='utf-8').read()
old = """  if (cls === 'scroll' || cls === 'spellbook') verbs.push('read');"""
new = """  if (cls === 'scroll') verbs.push('read');
  // 法术书：学过的可以施展，没学过的先研读。
  if (cls === 'spellbook') verbs.push(item.known ? 'cast' : 'read');"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('inventory.ts：法术书动作已区分')

# 5) main.ts：cast 属于直接动词
p = 'src/main.ts'
s = io.open(p, encoding='utf-8').read()
old = """const DIRECT_VERBS: ReadonlySet<string> = new Set(['wield', 'wear', 'remove', 'drop']);"""
new = """const DIRECT_VERBS: ReadonlySet<string> = new Set(['wield', 'wear', 'remove', 'drop', 'cast']);"""
assert old in s
io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new, 1))
print('main.ts：cast 已登记')

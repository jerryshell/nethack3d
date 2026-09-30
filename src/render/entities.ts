import * as THREE from 'three';
import { createItemModel, createMonsterModel, enableShadows } from './models';
import { createCharacter, lookForMonster } from './characters';
import type { CharacterHandle } from './characters';
import { tileToWorld } from './dungeonMesh';
import { lambertOf } from './palette';
import type { GameSession } from '../game/session';
import type { Monster } from '../types';
import { index } from '../game/dungeon';
import { objById } from '../data/index';

/**
 * 怪物图层。
 *
 * 每只存活怪物对应一个 3D 视图；不在视野内时隐藏（与原版可见性一致），
 * 移动时在瓦片之间插值，死亡时播放短暂淡出。
 */

/** 释放网格的几何体与材质。 */
function disposeMesh(o: THREE.Object3D): void {
  (o as THREE.Mesh).geometry?.dispose();
  const material = (o as THREE.Mesh).material;
  if (Array.isArray(material)) material.forEach((m) => m.dispose());
  else material?.dispose();
}

interface MonsterView {
  group: THREE.Group;
  target: THREE.Vector3;
  current: THREE.Vector3;
  flash: number;
  dying: number;
  bobPhase: number;
  lunge?: { dx: number; dy: number; t: number } | null;
  /** 人形怪物的人物模型；兽类为 null，用程序化外形。 */
  character?: CharacterHandle | null;
  /** 最近一次播放的动作，避免每帧重复切换。 */
  action?: string;
  /** 当前是否显示为伪装形态；现形后重建视图。 */
  disguised: boolean;
}

export class EntityLayer extends THREE.Group {
  views: Map<number, MonsterView>;
  time: number;

  constructor() {
    super();
    this.views = new Map(); // monsterId -> view
    this.time = 0;
  }

  /** 依据会话中的楼层与可见性同步视图。 */
  sync(session: GameSession): void {
    const level = session.level;
    const visible = session.visible;
    const alive = new Set();

    for (const mon of level.monsters) {
      alive.add(mon.id);
      let view = this.views.get(mon.id);
      // 拟形怪现出原形时重建视图，把巨石换成怪物模型。
      if (view && view.disguised !== !!mon.disguise) {
        this.remove(view.group);
        view.group.traverse(disposeMesh);
        view.character?.dispose();
        this.views.delete(mon.id);
        view = undefined;
      }
      if (!view) {
        const { group, character } = this.buildGroup(mon);
        group.position.set(0, 0, 0);
        this.add(group);
        view = {
          group,
          target: new THREE.Vector3(),
          current: new THREE.Vector3(),
          flash: 0,
          dying: 0,
          bobPhase: Math.random() * Math.PI * 2,
          character,
          action: character ? 'idle' : undefined,
          disguised: !!mon.disguise,
        };
        this.views.set(mon.id, view);
      }
      const w = tileToWorld(mon.x, mon.y);
      view.target.set(w.x, 0, w.z);
      if (view.current.lengthSq() === 0) view.current.copy(view.target);
      const i = index(mon.x, mon.y);
      const seen = !!visible && visible[i] === 1;
      // 心灵感应与怪物探测：感知 12 格内的怪物，即使隔着墙也能看到它的身影。
      const sensed =
        (session.hasTelepathy() || session.player.senseMonsters > 0) &&
        Math.max(Math.abs(mon.x - session.player.x), Math.abs(mon.y - session.player.y)) <= 12;
      view.group.visible = (seen || sensed) && view.dying === 0;
    }

    // Anything no longer alive fades out.
    for (const [id, view] of this.views) {
      if (!alive.has(id) && view.dying === 0) {
        view.dying = 0.001;
        view.group.visible = true;
        view.character?.play('die', { once: true, fade: 0.1 });
        view.action = 'die';
      }
    }
  }

  /** 依据怪物当前形态建视图组：伪装的拟形怪显示成巨石。 */
  private buildGroup(mon: Monster): { group: THREE.Group; character: CharacterHandle | null } {
    if (mon.disguise) {
      const proto = objById.get(mon.disguise);
      if (proto) {
        const model = createItemModel(proto);
        model.scale.setScalar(0.85);
        const group = new THREE.Group();
        group.add(model);
        // 参与实时阴影：怪物投射并接收脚边的光影。
        enableShadows(group);
        return { group, character: null };
      }
    }
    // 人形族群用带骨骼动画的人物模型，按怪物自身的颜色染色、按体型缩放。
    const look = lookForMonster(mon.data);
    const character = look
      ? createCharacter(look.key, { tint: mon.data.color, scale: look.scale })
      : null;
    const group = character ? character.root : createMonsterModel(mon.data);
    enableShadows(group);
    return { group, character };
  }

  /** 怪物当前的插值世界坐标；不存在时返回 null。 */
  positionOf(monsterId: number): THREE.Vector3 | null {
    const view = this.views.get(monsterId);
    return view ? view.current.clone() : null;
  }

  /** 受击时闪烁。 */
  flash(monsterId: number, color = 0xff4444): void {
    const view = this.views.get(monsterId);
    if (!view) return;
    view.flash = 0.35;
    view.group.traverse((o) => {
      const material = lambertOf(o);
      if (material) {
        material.emissive.setHex(color);
        material.emissiveIntensity = 0.8;
      }
    });
  }

  /** 攻击时朝目标方向做一次前冲。 */
  lunge(monsterId: number, dx: number, dy: number): void {
    const view = this.views.get(monsterId);
    if (!view) return;
    view.lunge = { dx: dx * 0.22, dy: dy * 0.22, t: 0.22 };
  }

  update(dt: number): void {
    this.time += dt;
    for (const [id, view] of this.views) {
      const g = view.group;
      if (view.dying > 0) {
        view.dying += dt;
        const k = Math.max(0, 1 - view.dying * 2.5);
        g.scale.setScalar(k);
        g.rotation.z = (1 - k) * 0.8;
        if (view.dying > 0.45) {
          this.remove(g);
          g.traverse(disposeMesh);
          view.character?.dispose();
          this.views.delete(id);
        }
        continue;
      }

      const t = 1 - Math.exp(-12 * dt);
      view.current.lerp(view.target, t);
      const moving = view.current.distanceToSquared(view.target) > 0.002;
      g.position.set(
        view.current.x,
        // 人物模型自带步态，不再叠加整体起伏。
        view.character ? 0 : moving ? Math.abs(Math.sin(this.time * 9 + view.bobPhase)) * 0.06 : 0,
        view.current.z,
      );
      if (moving)
        g.rotation.y = Math.atan2(view.target.x - view.current.x, view.target.z - view.current.z);

      if (view.character) {
        const attack = !!view.lunge;
        const next = attack ? 'attack-melee-right' : moving ? 'walk' : 'idle';
        if (view.action !== next) {
          view.character.play(next, { once: attack, fade: 0.12 });
          view.action = next;
        }
        view.character.update(dt);
      }

      if (view.lunge) {
        view.lunge.t -= dt;
        const k = Math.max(0, view.lunge.t / 0.22);
        g.position.x += view.lunge.dx * k;
        g.position.z += view.lunge.dy * k;
        if (view.lunge.t <= 0) view.lunge = null;
      }

      if (view.flash > 0) {
        view.flash -= dt;
        if (view.flash <= 0) {
          g.traverse((o) => {
            const material = lambertOf(o);
            if (material) material.emissiveIntensity = 0;
          });
        }
      }
    }
  }

  /** 清空所有怪物视图；命名避开 THREE.Group.clear()。 */
  clearAll(): void {
    for (const [, view] of this.views) {
      this.remove(view.group);
      view.group.traverse(disposeMesh);
      view.character?.dispose();
      view.character = null;
    }
    this.views.clear();
  }
}

import * as THREE from 'three';
import { createItemModel } from './models';
import { tileToWorld } from './dungeonMesh';
import type { GameSession } from '../game/session';
import type { Level } from '../types';
import { index } from '../game/dungeon';

/**
 * 地面物品。
 *
 * 每堆物品用一个小组展示最上面的几件；只有瓦片处于视野内时才可见
 * （与原版一致）。仅当堆内内容变化时才重建。
 */
export class ItemLayer extends THREE.Group {
  pileViews: Map<number, { group: THREE.Group; x: number; y: number }>;
  signature: string;
  time: number;

  constructor() {
    super();
    this.pileViews = new Map(); // tileIndex -> { group, x, y }
    this.signature = '';
    this.time = 0;
  }

  sync(session: GameSession): void {
    const level = session.level;
    const signature = level.objects
      .map((p) => `${p.x},${p.y}:${p.items.map((i) => i.uid).join('.')}`)
      .join(';');
    if (signature !== this.signature) {
      this.signature = signature;
      this.rebuild(level);
    }
    for (const [tileIndex, view] of this.pileViews) {
      const visible = !!session.visible && session.visible[tileIndex] === 1;
      view.group.visible = visible;
    }
  }

  rebuild(level: Level): void {
    for (const [, view] of this.pileViews) {
      this.remove(view.group);
      view.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
    }
    this.pileViews.clear();

    for (const pile of level.objects) {
      if (!pile.items.length) continue;
      const tileIndex = index(pile.x, pile.y);
      const w = tileToWorld(pile.x, pile.y);
      const group = new THREE.Group();
      group.position.set(w.x, 0, w.z);
      const shown = pile.items.slice(-3);
      shown.forEach((item, n) => {
        const model = createItemModel(item.proto);
        model.scale.setScalar(0.85);
        model.position.set((n - 1) * 0.22, 0, (n % 2) * 0.18 - 0.09);
        group.add(model);
      });
      group.userData.gold = pile.items.some((i) => i.gold);
      this.add(group);
      this.pileViews.set(tileIndex, { group, x: pile.x, y: pile.y });
    }
  }

  update(dt: number): void {
    this.time += dt;
    for (const [, view] of this.pileViews) {
      if (view.group.userData.gold) {
        view.group.rotation.y = Math.sin(this.time * 1.5) * 0.15;
      }
    }
  }

  clearAll(): void {
    for (const [, view] of this.pileViews) {
      this.remove(view.group);
      view.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
    }
    this.pileViews.clear();
    this.signature = '';
  }
}

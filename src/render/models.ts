import * as THREE from 'three';
import type { MonsterData, ObjectData } from '../types';

/**
 * 程序化低多边形模型。
 *
 * 全部由基础几何体拼装，因此项目不携带美术资源。
 * 返回的 THREE.Group 在 `userData.bob` 中标记待机动画部件。
 */

const mat = (
  color: number,
  opts: THREE.MeshLambertMaterialParameters = {},
): THREE.MeshLambertMaterial => new THREE.MeshLambertMaterial({ color, ...opts });

function box(
  w: number,
  h: number,
  d: number,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return m;
}

function sphere(r: number, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), material);
  m.position.set(x, y, z);
  return m;
}

/**
 * 玩家角色模型；`color` 用于区分职业与种族配色。
 */
export function createPlayerModel({
  color = 0xd8b45c,
  cloak = 0x7a2f2f,
}: { color?: number; cloak?: number } = {}): THREE.Group {
  const g = new THREE.Group();
  const skin = mat(0xe0b090);
  const tunic = mat(color);
  const cloakMat = mat(cloak);
  const leather = mat(0x6b4a2f);
  const steel = mat(0xb8bec8, { emissive: 0x111418 });

  // 双腿
  const legL = box(0.14, 0.3, 0.14, leather, -0.09, 0.15, 0);
  const legR = box(0.14, 0.3, 0.14, leather, 0.09, 0.15, 0);
  // 躯干与头部
  const torso = box(0.36, 0.42, 0.24, tunic, 0, 0.51, 0);
  const head = sphere(0.14, skin, 0, 0.82, 0);
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.26, 10), cloakMat);
  hood.position.set(0, 0.88, -0.02);
  // 披风
  const cape = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.7, 8, 1, true), cloakMat);
  cape.position.set(0, 0.5, -0.1);
  cape.scale.set(0.7, 1, 0.35);
  // 双臂
  const armL = box(0.1, 0.34, 0.1, tunic, -0.23, 0.52, 0);
  const armR = box(0.1, 0.34, 0.1, tunic, 0.23, 0.52, 0);
  // 左手持盾，右手持剑
  const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.04, 12), steel);
  shield.rotation.z = Math.PI / 2;
  shield.rotation.y = Math.PI / 2;
  shield.position.set(-0.3, 0.5, 0.05);
  const blade = box(0.05, 0.5, 0.02, steel, 0.3, 0.72, 0.06);
  const guard = box(0.16, 0.04, 0.04, mat(0x8a6b2f), 0.3, 0.48, 0.06);

  g.add(legL, legR, torso, head, hood, cape, armL, armR, shield, blade, guard);
  g.userData.bob = [legL, legR, cape];
  g.userData.kind = 'player';
  return g;
}

const MONSTER_COLORS: Record<string, number> = {
  a: 0xaa5500,
  b: 0x66cc66,
  c: 0x9a8b2f,
  d: 0xaa7733,
  e: 0xffffff,
  f: 0xcc8844,
  g: 0x66cc66,
  h: 0xccb28a,
  i: 0xcc3333,
  j: 0x66cccc,
  k: 0x99aa33,
  l: 0x33cc66,
  m: 0x8899aa,
  n: 0xffaacc,
  o: 0x99bb44,
  p: 0x887755,
  q: 0xcc7733,
  r: 0xaa8855,
  s: 0x666688,
  t: 0x779966,
  u: 0xffffff,
  v: 0x66aaff,
  w: 0xaa7744,
  x: 0x8866aa,
  y: 0xffff88,
  z: 0x669966,
  A: 0xffeeaa,
  B: 0x665544,
  C: 0xb08050,
  D: 0xcc3333,
  E: 0x66ddff,
  F: 0x88aa66,
  G: 0xaa8866,
  H: 0x996633,
  J: 0xaa44aa,
  K: 0x2266cc,
  L: 0x66aa88,
  M: 0xbbbb99,
  N: 0x44aa44,
  O: 0x997744,
  P: 0x66ffcc,
  Q: 0xaaaaaa,
  R: 0x996644,
  S: 0x44bb44,
  T: 0x88aa77,
  U: 0x776655,
  V: 0xaa2222,
  W: 0x9999cc,
  X: 0x886644,
  Y: 0xdddddd,
  Z: 0x889988,
  '@': 0xffd8a0,
  '&': 0xaa2222,
  ';': 0x4488cc,
  ':': 0x66bb44,
  '~': 0xaaaa66,
  "'": 0xcccccc,
  ' ': 0xddddff,
};

/**
 * 依据 NetHack 字形类别生成怪物模型：
 * 昆虫爬行、四足兽四条腿、龙有翅膀、人形直立等。
 */
export function createMonsterModel(
  mon: MonsterData,
  { scale = 1 }: { scale?: number } = {},
): THREE.Group {
  const g = new THREE.Group();
  const base = MONSTER_COLORS[mon.glyph] ?? 0x997755;
  const body = mat(base);
  const dark = mat(new THREE.Color(base).multiplyScalar(0.6).getHex());
  const eye = mat(0xff3333, { emissive: 0x661111 });

  const kind = classifyGlyph(mon.glyph);
  switch (kind) {
    case 'insect': {
      g.add(sphere(0.16 * scale, body, 0, 0.16, 0));
      for (let i = 0; i < 6; i++) {
        const leg = box(
          0.04,
          0.16,
          0.04,
          dark,
          i % 2 ? 0.14 : -0.14,
          0.08,
          (Math.floor(i / 2) - 1) * 0.12,
        );
        g.add(leg);
      }
      g.add(sphere(0.05, eye, 0.08, 0.2, 0.12), sphere(0.05, eye, -0.08, 0.2, 0.12));
      break;
    }
    case 'quadruped': {
      const torso = box(0.34 * scale, 0.2 * scale, 0.6 * scale, body, 0, 0.26 * scale, 0);
      const head = box(
        0.22 * scale,
        0.2 * scale,
        0.24 * scale,
        body,
        0,
        0.36 * scale,
        0.38 * scale,
      );
      g.add(torso, head);
      for (const [dx, dz] of [
        [-0.12, 0.22],
        [0.12, 0.22],
        [-0.12, -0.22],
        [0.12, -0.22],
      ]) {
        g.add(box(0.07, 0.24, 0.07, dark, dx * scale, 0.12 * scale, dz * scale));
      }
      g.add(
        sphere(0.035, eye, 0.07, 0.4 * scale, 0.5 * scale),
        sphere(0.035, eye, -0.07, 0.4 * scale, 0.5 * scale),
      );
      break;
    }
    case 'humanoid': {
      g.add(box(0.3 * scale, 0.42 * scale, 0.2 * scale, body, 0, 0.5 * scale, 0));
      g.add(sphere(0.13 * scale, body, 0, 0.8 * scale, 0));
      g.add(box(0.1 * scale, 0.3 * scale, 0.1 * scale, dark, -0.17 * scale, 0.2 * scale, 0));
      g.add(box(0.1 * scale, 0.3 * scale, 0.1 * scale, dark, 0.17 * scale, 0.2 * scale, 0));
      g.add(
        sphere(0.028, eye, 0.05, 0.82 * scale, 0.1 * scale),
        sphere(0.028, eye, -0.05, 0.82 * scale, 0.1 * scale),
      );
      break;
    }
    case 'dragon': {
      const torso = box(0.4 * scale, 0.3 * scale, 0.66 * scale, body, 0, 0.3 * scale, 0);
      const head = box(
        0.24 * scale,
        0.22 * scale,
        0.3 * scale,
        body,
        0,
        0.42 * scale,
        0.42 * scale,
      );
      g.add(torso, head);
      const wingGeo = new THREE.BoxGeometry(0.05, 0.5 * scale, 0.5 * scale);
      const wingMat = mat(new THREE.Color(base).multiplyScalar(0.8).getHex(), {
        transparent: true,
        opacity: 0.9,
      });
      const wingL = new THREE.Mesh(wingGeo, wingMat);
      wingL.position.set(-0.3 * scale, 0.5 * scale, -0.05);
      wingL.rotation.z = 0.5;
      const wingR = wingL.clone();
      wingR.position.x = 0.3 * scale;
      wingR.rotation.z = -0.5;
      g.add(wingL, wingR);
      for (const [dx, dz] of [
        [-0.14, 0.2],
        [0.14, 0.2],
        [-0.14, -0.2],
        [0.14, -0.2],
      ]) {
        g.add(box(0.08, 0.26, 0.08, dark, dx * scale, 0.13 * scale, dz * scale));
      }
      g.add(
        sphere(0.04, eye, 0.08, 0.46 * scale, 0.55 * scale),
        sphere(0.04, eye, -0.08, 0.46 * scale, 0.55 * scale),
      );
      break;
    }
    case 'blob': {
      g.add(sphere(0.3 * scale, body, 0, 0.24 * scale, 0));
      g.add(sphere(0.16 * scale, body, 0.2 * scale, 0.14 * scale, 0.1 * scale));
      g.add(
        sphere(0.035, eye, 0.1, 0.3 * scale, 0.24 * scale),
        sphere(0.035, eye, -0.1, 0.3 * scale, 0.24 * scale),
      );
      break;
    }
    case 'spirit': {
      const shade = mat(base, { transparent: true, opacity: 0.55 });
      g.add(box(0.34 * scale, 0.6 * scale, 0.2 * scale, shade, 0, 0.55 * scale, 0));
      g.add(sphere(0.15 * scale, shade, 0, 0.92 * scale, 0));
      g.add(
        sphere(0.03, eye, 0.06, 0.92 * scale, 0.12 * scale),
        sphere(0.03, eye, -0.06, 0.92 * scale, 0.12 * scale),
      );
      break;
    }
    case 'snake': {
      g.add(sphere(0.14 * scale, body, 0, 0.16 * scale, 0.2 * scale));
      const seg1 = box(
        0.14 * scale,
        0.14 * scale,
        0.4 * scale,
        body,
        0,
        0.14 * scale,
        -0.14 * scale,
      );
      const seg2 = box(
        0.12 * scale,
        0.12 * scale,
        0.3 * scale,
        dark,
        0,
        0.12 * scale,
        -0.4 * scale,
      );
      g.add(seg1, seg2);
      g.add(
        sphere(0.03, eye, 0.06, 0.2 * scale, 0.3 * scale),
        sphere(0.03, eye, -0.06, 0.2 * scale, 0.3 * scale),
      );
      break;
    }
    default:
      g.add(sphere(0.22 * scale, body, 0, 0.22 * scale, 0));
      g.add(
        sphere(0.04, eye, 0.08, 0.26 * scale, 0.18 * scale),
        sphere(0.04, eye, -0.08, 0.26 * scale, 0.18 * scale),
      );
  }
  g.userData.kind = kind;
  g.userData.bob = [];
  return g;
}

const GLYPH_KINDS = (() => {
  const map: Record<string, string> = {};
  const add = (kind: string, chars: string): void => {
    for (const ch of chars) map[ch] = kind;
  };
  add('insect', 'asx'); // ants, spiders, xans
  add('quadruped', 'cdfqruC RXYZ:'.replace(/ /g, '')); // birds, dogs, cats, rodents, unicorns, centaurs
  add('humanoid', '@AgGhHiKkLlMnOopQTUV&'); // humans, giants, liches, vampires, demons
  add('dragon', 'DJ');
  add('blob', 'befFjmPt'); // blobs, eyes, fungi, jellies, mimics, puddings, trappers
  add('spirit', 'EIW y'.replace(/ /g, '')); // elementals, invisible stalkers, wraiths, lights
  add('snake', 'NS;~'); // snakes, nagas, eels, worms
  return map;
})();

function classifyGlyph(glyph: string): string {
  return GLYPH_KINDS[glyph] ?? 'blob';
}

/** 按物品类别生成的简化模型，用于地面堆叠与背包展示。 */
export function createItemModel(obj: ObjectData, appearance: { color?: number } = {}): THREE.Group {
  const color = objectColor(obj, appearance);
  const g = new THREE.Group();
  const m = mat(color, color === 0x66ffff ? { emissive: 0x113333 } : {});
  switch (obj.cls) {
    case 'weapon': {
      g.add(box(0.05, 0.5, 0.05, m, 0, 0.25, 0));
      g.add(box(0.16, 0.04, 0.04, mat(0x6b4a2f), 0, 0.06, 0));
      break;
    }
    case 'armor': {
      g.add(box(0.3, 0.34, 0.2, m, 0, 0.18, 0));
      break;
    }
    case 'potion':
    case 'wand': {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.26, 10), m);
      body.position.y = 0.13;
      g.add(body);
      if (obj.cls === 'potion') {
        const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.08, 8), mat(0x8a6b2f));
        cork.position.y = 0.3;
        g.add(cork);
      }
      break;
    }
    case 'scroll':
    case 'spellbook': {
      g.add(box(0.26, 0.08, 0.34, m, 0, 0.04, 0));
      if (obj.cls === 'spellbook') g.add(box(0.28, 0.04, 0.36, mat(0x5a3a1a), 0, 0.1, 0));
      break;
    }
    case 'ring':
    case 'amulet': {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.028, 8, 14), m);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.1;
      g.add(ring);
      break;
    }
    case 'gem':
    case 'rock': {
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.13), m);
      gem.position.y = 0.13;
      g.add(gem);
      break;
    }
    case 'food': {
      g.add(sphere(0.13, m, 0, 0.13, 0));
      break;
    }
    case 'tool': {
      g.add(box(0.24, 0.24, 0.24, m, 0, 0.12, 0));
      break;
    }
    case 'coin': {
      for (let i = 0; i < 4; i++) {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.02, 10), m);
        c.position.set((i % 2) * 0.08 - 0.04, 0.02 + i * 0.022, Math.floor(i / 2) * 0.08 - 0.04);
        g.add(c);
      }
      break;
    }
    default: {
      g.add(sphere(0.12, m, 0, 0.12, 0));
    }
  }
  g.userData.kind = 'item';
  g.userData.class = obj.cls;
  return g;
}

function objectColor(obj: ObjectData, appearance: { color?: number }): number {
  if (appearance?.color) return appearance.color;
  if (obj.color) return new THREE.Color(obj.color).getHex();
  return 0xaaaaaa;
}

export { MONSTER_COLORS, classifyGlyph };

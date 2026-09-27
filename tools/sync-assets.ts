/**
 * 从 Kenney 素材库同步选定的模型到 `public/assets/kenney/`。
 *
 * 素材为 CC0（公共领域），随仓库提交，因此构建与运行不依赖素材库是否挂载。
 * 清单记录每个文件的体积与散列，`--check` 可校验仓库内素材是否与清单一致。
 *
 * ```bash
 * bun tools/sync-assets.ts                  # 同步素材（需要素材库）
 * bun tools/sync-assets.ts --check          # 校验已提交的素材
 * bun tools/sync-assets.ts --src=D:/path    # 指定素材库位置
 * ```
 *
 * 素材库位置也可用环境变量 `KENNEY_SRC` 指定。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 素材包在素材库中的相对路径。 */
const PACK = '3D assets/Mini Dungeon';

/** 本包在素材库中的目标目录（GLB 与贴图）。 */
const PACK_FILES = 'Models/GLB format';

/** 随仓库提交的素材目录。 */
const TARGET_DIR = 'public/assets/kenney';

/** 清单文件，记录来源与散列。 */
const MANIFEST_PATH = path.join(TARGET_DIR, 'manifest.json');

/**
 * 选定的模型。
 *
 * 只取当前用得到的部分：地面与墙体是画面主体，其余为地形设施与容器。
 * 模型体积都很小（1 到 40KB），整包同步没有意义。
 */
const MODELS = [
  'floor',
  'floor-detail',
  'dirt',
  'wall',
  'wall-half',
  'wall-opening',
  'column',
  'stairs',
  'gate',
  'trap',
  'barrel',
  'chest',
  'pot',
  'rocks',
];

/** 共用贴图集，所有模型通过 UV 引用它。 */
const TEXTURE = 'Textures/colormap.png';

/** Mini Characters 包：提供若干体型不同的人物。 */
const CHARACTERS_PACK = '3D assets/Mini Characters';
const CHARACTERS_DIR = 'characters';

/**
 * 带骨骼动画的人物模型（来源与目标相对路径）。
 *
 * 每个模型自带 idle、walk、attack-melee、die 等 32 段动画，
 * 与地牢模型同属 Mini 系列，风格一致。
 */
const CHARACTER_MODELS: Array<[string, string]> = [
  ['human.glb', '3D assets/Mini Dungeon/Models/GLB format/character-human.glb'],
  ['orc.glb', '3D assets/Mini Dungeon/Models/GLB format/character-orc.glb'],
  ['knight.glb', `${CHARACTERS_PACK}/Models/GLB format/character-male-a.glb`],
  ['rogue.glb', `${CHARACTERS_PACK}/Models/GLB format/character-female-b.glb`],
];

/**
 * 音效（来源相对路径 -> 目标文件名）。
 *
 * 只挑与动作一一对应的少数几个，整包同步没有意义。
 */
const SOUNDS: Array<[string, string]> = [
  ['audio/step-1.ogg', 'Audio/Impact Sounds/Audio/footstep_concrete_000.ogg'],
  ['audio/step-2.ogg', 'Audio/Impact Sounds/Audio/footstep_concrete_004.ogg'],
  ['audio/step-3.ogg', 'Audio/Impact Sounds/Audio/footstep_concrete_003.ogg'],
  ['audio/step-4.ogg', 'Audio/Impact Sounds/Audio/footstep_concrete_002.ogg'],
  ['audio/hit-heavy.ogg', 'Audio/Impact Sounds/Audio/impactPunch_heavy_000.ogg'],
  ['audio/hit-light.ogg', 'Audio/Impact Sounds/Audio/impactPunch_medium_000.ogg'],
  ['audio/hit-metal.ogg', 'Audio/Impact Sounds/Audio/impactMetal_heavy_004.ogg'],
  ['audio/hit-wood.ogg', 'Audio/Impact Sounds/Audio/impactWood_medium_000.ogg'],
  ['audio/mining.ogg', 'Audio/Impact Sounds/Audio/impactMining_000.ogg'],
  ['audio/body-fall.ogg', 'Audio/Impact Sounds/Audio/impactSoft_heavy_000.ogg'],
  ['audio/slice.ogg', 'Audio/RPG Audio/Audio/cloth1.ogg'],
  ['audio/chop.ogg', 'Audio/Impact Sounds/Audio/impactWood_heavy_002.ogg'],
  ['audio/coins.ogg', 'Audio/Interface Sounds/Audio/glass_003.ogg'],
  ['audio/potion.ogg', 'Audio/Interface Sounds/Audio/glass_006.ogg'],
  ['audio/book.ogg', 'Audio/RPG Audio/Audio/bookPlace2.ogg'],
  ['audio/door-open.ogg', 'Audio/RPG Audio/Audio/creak2.ogg'],
  ['audio/door-close.ogg', 'Audio/RPG Audio/Audio/doorClose_4.ogg'],
  ['audio/descend.ogg', 'Audio/RPG Audio/Audio/creak3.ogg'],
  ['audio/level-up.ogg', 'Audio/Interface Sounds/Audio/bong_001.ogg'],
  ['audio/click.ogg', 'Audio/Interface Sounds/Audio/back_004.ogg'],
  ['audio/select.ogg', 'Audio/Interface Sounds/Audio/back_002.ogg'],
  ['audio/confirm.ogg', 'Audio/Interface Sounds/Audio/confirmation_001.ogg'],
  ['audio/error.ogg', 'Audio/Interface Sounds/Audio/error_005.ogg'],
  ['audio/open.ogg', 'Audio/Interface Sounds/Audio/maximize_009.ogg'],
  ['audio/close.ogg', 'Audio/Interface Sounds/Audio/minimize_009.ogg'],
];

interface ManifestFile {
  bytes: number;
  sha256: string;
}

interface Manifest {
  version: number;
  pack: string;
  license: string;
  source: string;
  files: Record<string, ManifestFile>;
}

/** 素材库默认位置。 */
function defaultSource(): string {
  return process.env.KENNEY_SRC ?? 'D:/kenney.game.assets.all.in.one.3.7.0';
}

/** 解析命令行参数。 */
function parseArgs(argv: string[]): { check: boolean; src: string } {
  let check = false;
  let src = defaultSource();
  for (const arg of argv) {
    if (arg === '--check') check = true;
    else if (arg.startsWith('--src=')) src = arg.slice(6);
  }
  return { check, src };
}

/** 计算 sha256 前 16 位。 */
function hashFile(file: string): string {
  return new Bun.CryptoHasher('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

/** 需要同步的文件清单：目标相对路径 -> 素材库相对路径。 */
function plan(): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const name of MODELS) {
    entries.push([`${name}.glb`, `${PACK}/${PACK_FILES}/${name}.glb`]);
  }
  entries.push([TEXTURE, `${PACK}/${PACK_FILES}/${TEXTURE}`]);
  for (const [target, source] of CHARACTER_MODELS) {
    entries.push([`${CHARACTERS_DIR}/${target}`, source]);
  }
  // 人物模型引用自己包内的贴图集，路径必须与模型同目录结构。
  entries.push([`${CHARACTERS_DIR}/${TEXTURE}`, `${CHARACTERS_PACK}/Models/GLB format/${TEXTURE}`]);
  for (const [target, source] of SOUNDS) {
    entries.push([target, source]);
  }
  return entries;
}

/** 同步素材到仓库。 */
function sync(src: string): void {
  if (!fs.existsSync(path.join(src, PACK))) {
    console.error(`素材库中找不到 ${PACK}：${src}`);
    console.error('用 --src= 或 KENNEY_SRC 指定素材库位置。');
    process.exit(2);
  }

  const files: Record<string, ManifestFile> = {};
  for (const [target, source] of plan()) {
    const from = path.join(src, source);
    if (!fs.existsSync(from)) {
      console.error(`缺少素材文件：${source}`);
      process.exit(2);
    }
    const to = path.join(TARGET_DIR, target);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    files[target] = { bytes: fs.statSync(to).size, sha256: hashFile(to) };
  }

  // 许可声明随素材一起提交，便于后续核对来源。
  // 素材库里的文本是 CRLF，写入仓库前统一为 LF，避免每次同步都产生差异。
  const license = fs.readFileSync(path.join(src, PACK, 'License.txt'), 'utf8');
  const notice = `Kenney 素材（${PACK}）\n\n${license.trim()}\n`.replace(/\r\n/g, '\n');
  fs.writeFileSync(path.join(TARGET_DIR, 'LICENSE.txt'), notice, 'utf8');

  const manifest: Manifest = {
    version: 1,
    pack: PACK,
    license: 'CC0-1.0',
    source: 'https://kenney.nl',
    files,
  };
  // oxfmt 会把能放下的数组保持单行，这里让生成结果与之一致，
  // 否则每次同步后 fmt:check 都会失败。
  const lines = JSON.stringify(manifest, null, 2).split('\n');
  const start = lines.findIndex((line) => line.startsWith('  "packs"'));
  const end = lines.findIndex((line, i) => i > start && line.trim() === '],');
  if (start >= 0 && end > start) {
    const inline = manifest.packs.map((p) => JSON.stringify(p)).join(', ');
    lines.splice(start, end - start + 1, `  "packs": [${inline}],`);
  }
  fs.writeFileSync(MANIFEST_PATH, `${lines.join('\n')}\n`, 'utf8');

  const total = Object.values(files).reduce((sum, f) => sum + f.bytes, 0);
  console.log(`同步 ${Object.keys(files).length} 个文件，合计 ${(total / 1024).toFixed(0)}KB`);
}

/** 校验仓库内素材是否与清单一致。 */
function check(): number {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('缺少清单文件，先运行 bun tools/sync-assets.ts');
    return 2;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  let problems = 0;

  for (const [rel, expected] of Object.entries(manifest.files)) {
    const file = path.join(TARGET_DIR, rel);
    if (!fs.existsSync(file)) {
      console.error(`缺失：${rel}`);
      problems++;
      continue;
    }
    const actual = { bytes: fs.statSync(file).size, sha256: hashFile(file) };
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      console.error(`内容变化：${rel}`);
      problems++;
    }
  }

  const listed = new Set(Object.keys(manifest.files));
  for (const name of fs.readdirSync(TARGET_DIR)) {
    if (name === 'manifest.json' || name === 'LICENSE.txt') continue;
    if (name === 'Textures' || name === 'characters' || name === 'audio') {
      // 子目录逐个比对，缺一个都算异常。
      const walk = (rel: string): void => {
        for (const sub of fs.readdirSync(path.join(TARGET_DIR, rel))) {
          const child = `${rel}/${sub}`;
          if (fs.statSync(path.join(TARGET_DIR, child)).isDirectory()) {
            walk(child);
            continue;
          }
          if (!listed.has(child)) {
            console.error(`清单外的文件：${child}`);
            problems++;
          }
        }
      };
      walk(name);
      continue;
    }
    if (!listed.has(name)) {
      console.error(`清单外的文件：${name}`);
      problems++;
    }
  }

  if (problems) {
    console.error(`素材校验失败，${problems} 处问题`);
    return 1;
  }
  console.log(
    `素材与清单一致：${Object.keys(manifest.files).length} 个文件，${manifest.pack}，${manifest.license}`,
  );
  return 0;
}

const options = parseArgs(process.argv.slice(2));
if (options.check) {
  process.exit(check());
} else {
  sync(options.src);
}

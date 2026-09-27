# 许可与来源说明

本仓库包含三类来源不同的材料，各自的许可如下。

## 1. 项目代码与数据：NetHack General Public License

本项目的全部内容按 NetHack General Public License（NGPL）分发，条文见 `LICENSE`。

之所以不是 MIT 之类的宽松许可，是因为游戏的怪物、物品与职业数据由脚本从 NetHack 5.0
源码提取，界面文案也是 NetHack 消息的翻译。这些内容属于 NetHack 的一部分，
而 NGPL 的条款 2b 要求：包含或派生自 NetHack 的作品，整体必须以相同条款免费授权。
提取脚本本身（`tools/extract-*.ts`）是原创代码，但它生成的 `src/data/*.gen.ts`
来自 NetHack，因此整个作品适用于同一条款。

参考版本记录在 `tools/nethack-reference.json`，可用 `bun run sync:check` 检查是否漂移：

| 项目         | 值                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------- |
| 上游仓库     | `https://github.com/NetHack/NetHack`                                                           |
| 分支         | `NetHack-5.0`                                                                                  |
| 提交         | `c1b1b08e95dc5e5ad55760e20affd45de5dd7e90`                                                     |
| 提取的源文件 | `include/monsters.h`、`include/objects.h`、`include/defsym.h`、`include/color.h`、`src/role.c` |

NetHack 的版权归其作者所有，主要包括：Stichting Mathematisch Centrum（1985 年起）、
M. Stephenson，以及后续的贡献者。逐文件的版权声明见上游源码文件头部。

## 2. 模型素材：CC0

`public/assets/kenney/` 下的模型来自 Kenney 的 Mini Dungeon 包，
采用 CC0 1.0（公共领域贡献）许可，可自由使用、修改与再分发，无需署名。
来源与散列记录在 `public/assets/kenney/manifest.json`，许可原文见
`public/assets/kenney/LICENSE.txt`。

## 3. 第三方依赖：各自许可

依赖不因本项目而改变许可。主要几项：

| 依赖           | 许可       |
| -------------- | ---------- |
| three.js       | MIT        |
| Vite           | MIT        |
| TypeScript     | Apache-2.0 |
| oxlint / oxfmt | MIT        |

## 分发者需要遵守的事项

NGPL 的要求可以概括为三点：

1. 分发时附带本许可文件，并保留各文件中的版权声明。
2. 修改过的文件要注明改动，例如在文件头部记录来源与修改日期。
3. 提供的作品整体必须继续以 NGPL 条款免费授权给第三方；分发可执行形式时，
   必须一并提供或指明如何取得完整源码。据此，本作品不能改以 MIT 等更宽松的
   许可重新发布，也不允许闭源分发。

以源码形式发布在 GitHub 上已经满足第 3 条的源码要求。

## 本项目与 NetHack 官方的关系

本项目是个人开发的非官方重制，与 NetHack 开发团队无关，也不代表其立场。
「NetHack」为其权利人的名称，本项目仅作指称之用。

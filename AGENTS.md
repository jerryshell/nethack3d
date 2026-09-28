# AGENTS.md

本文件是给自动化 Agent 的操作契约。修改本仓库前先读这里，再读 `docs/AGENT-LOOP.md`。

## 项目概览

浏览器中的三维 NetHack 复刻，Bun + TypeScript + Vite + three.js。
游戏数据由脚本从 NetHack 5.0 源码提取，规则与数值沿用原版。

## 命令

| 命令                                 | 用途                                            |
| ------------------------------------ | ----------------------------------------------- |
| `bun run verify`                     | 提交前必跑：格式、严格 lint、类型、自检、构建   |
| `bun run agent`                      | 反馈循环：场景 + 模糊测试 + 地图审计 + 快照比对 |
| `bun run agent:json`                 | 同上，输出机器可读报告                          |
| `bun run agent:list`                 | 列出全部场景与说明                              |
| `bun run agent:repl`                 | 交互式观察游戏状态（逐条命令返回 JSON）         |
| `bun run agent:e2e`                  | 浏览器端到端检查，产出截图与分步耗时            |
| `bun run agent:e2e:preview`          | 同上，但检查生产构建产物                        |
| `bun run agent:smoke`                | 全流程冒烟测试，逐步截图供人工复核              |
| `bun run verify:release`             | 发布前总检查：verify:full 加生产产物端到端      |
| `bun run verify:full`                | `verify` 加 `agent`，改动游戏逻辑后使用         |
| `bun run sync:check`                 | 检查参考仓库是否更新，漂移时退出码为 1          |
| `bun run assets:check`               | 校验模型素材与清单一致（已纳入 verify）         |
| `bun run sync:record`                | 记录当前参考版本（重新提取之后）                |
| `bun run check`                      | 引擎自检（623 项断言，带覆盖率门槛）            |
| `bun run test` / `test:watch`        | 运行测试 / 监听模式                             |
| `bun run typecheck` / `lint` / `fmt` | 类型、静态检查、格式化                          |

单独复现某个失败：

```bash
bun tools/agent-loop.ts --scenario=combat --seed=20240101
bun tools/agent-loop.ts --fuzz-seed=20248020
bun tools/agent-loop.ts --update-golden      # 仅在确认行为变更为预期时
```

## 参考版本

游戏数据来自参考 NetHack 仓库，版本记录在 `tools/nethack-reference.json`。
开始工作前先确认是否漂移：

```bash
bun run sync:check              # 漂移时退出码为 1
bun run sync:check --json       # 机器可读
```

检出漂移时的顺序是：查看差异（`--full-diff`）→ `bun run extract` →
`bun run agent`（必要时更新快照）→ `bun run sync:record` → 更新文档。
流程细节与常见情况见 `docs/NETHACK-SYNC.md`。

## 迭代流程

1. **运行**：`bun run agent:json` 获取报告，或 `bun run verify:full` 做完整校验。
2. **定位**：读报告中的 `failures`。每条失败都带有 `check`、`detail` 与 `repro`；
   `tools/agent-artifacts/failures/*.txt` 保存失败现场的地图与状态摘要。
3. **修复**：改游戏逻辑或测试用例。判断依据是「不变量被破坏」还是「场景预期需要调整」。
4. **复现**：用 `repro` 命令确认修复，再跑一次完整循环确认没有引入回归。
5. **快照**：若 `golden.mismatched` 非空，先判断变更是否预期；
   预期则 `--update-golden`，并在提交信息里写清原因。
6. **提交**：`bun run verify` 通过后提交，提交信息用中文，说明动机与影响。

## 报告字段

```jsonc
{
  "ok": true, // 全部检查是否通过
  "baseSeed": 20240101, // 本次基础种子
  "totals": { "scenarios": 10, "failedScenarios": 0, "actions": 1278 },
  "scenarios": [{ "name": "combat", "ok": true, "metrics": {} }],
  "golden": { "compared": 32, "mismatched": [] },
  "failures": [{ "scope": "combat", "check": "至少命中一次", "repro": "..." }],
  "hints": ["下一步建议"],
}
```

`metrics` 是观察行为是否合理的依据，例如战斗场景的命中次数、下潜场景的到达层数。

`reference` 字段给出参考仓库状态：`up-to-date`、`drift` 或 `unavailable`（参考仓库不可用时）。
状态为 `drift` 时先按 `docs/NETHACK-SYNC.md` 同步数据，再判断游戏侧是否需要配套改动。

## 不变量

`tools/agent-lib.ts` 的 `checkInvariants` 是所有判定的基础，当前覆盖：

- 玩家位于可通行格子内，坐标不越界。
- 生命、法力、等级、经验、金币在合法区间；死亡时生命为 0 且标记一致。
- 怪物位于可通行格子，不互相重叠，不与玩家重叠，生命与行动力合法。
- 地面物品堆非空、位于可通行格子、数量不小于 1。
- 装备槽指向的物品必须仍在背包中。
- 未付款的商店货品不在背包中，商店房间完整可通行，店主不离开店。
- 地形设施位于对应类型的格子上，且保持可通行。
- 阵营记录在 [-128, 127] 内，祈祷冷却非负，祭坛归属合法。
- 变形形态必须存在于怪物数据中，剩余回合非负。
- 楼梯标记与瓦片一致，且上下行楼梯按规则存在。
- 迷雾只增不减（换层自动重置基线）。

地图结构与渲染另有专项检查：`auditDoors` 从 ASCII 地图核对门满足
「前后是通道、两侧是墙」，由自检与 `--map-fuzz` 运行；门板位置与朝向
由端到端在真实模型上核对。

新增机制时同步补充不变量，否则循环无法发现该类回归。

## 场景

场景位于 `tools/agent-scenarios.ts`，全部确定性可复现。
新增场景的要求：

1. 只用 `newSession(seed, ...)` 建立状态，不依赖模块级全局。
2. 每次状态变更后调用 `checkInvariants`，把问题交给 `Checker.absorb`。
3. 通过 `checker.attachDump` 注册现场快照。
4. 失败必须给出 `repro` 命令。
5. 用 `metrics` 暴露关键计数，便于 Agent 判断行为是否合理。

## 代码约定

- TypeScript 严格模式，`tsc --noEmit` 必须零错误。
- 注释、文档、提交信息使用简体中文，遵循项目内的中文排版规范：
  直角引号、中英文之间留空格、不使用第二人称、不加感叹号。
- 格式化与静态检查由 oxfmt 与 oxlint 负责，提交前执行 `bun run fmt` 与 `bun run lint`。
- 生成文件（`src/data/*.gen.ts`、`tools/agent-golden.json`）不要手改；
  前者用 `bun run extract` 重新生成，后者用 `--update-golden` 更新。
- 项目按 NetHack General Public License 分发（见 `NOTICE.md`）。
  新增依赖或素材必须与该许可兼容，不要引入禁止再分发的内容；
  生成文件的头部必须保留来源与许可声明。

## 边界

- 不要为了让检查通过而删除断言或放宽不变量；确有必要时在提交信息中说明理由。
- 不要提交 `tools/agent-artifacts/` 下的产物，该目录已被忽略。
- 未实现的功能记录在 `docs/COGNITION.md` 的「已知边界」中，扩展前先更新该文件。

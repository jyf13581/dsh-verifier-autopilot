# P1 固定小题集实验预注册

> 状态：**预注册，尚未执行，未消耗任何实弹配额**。本文是 review R7 决策备忘录（docs/reviews/R7-DOCS-PRODUCT-DIRECTION.md）指定的"是否继续投入"判据。
> 执行后只允许追加"偏差记录"章节，不得回改指标定义或阈值。
> 日期：2026-10-09　工具基线：`eval/p1/metrics.mjs` @ 本提交（指标与判定规则由 `scripts/tests/p1-metrics.test.mjs` 固定）　关联：README.md「Status」、eval/experiments/repair-v2.preregistration.md（legacy 旧路线，不执行）

## 1. 目标问题

R7 之前，autopilot（`selectionMode=auto`）和 legacy 五路 verifier（`enabled=true`）都默认开启，但仓库里没有任何证据证明它们改善了交付结果：

- selection ledger 有 31 次运行，只有 8 次产生了真实排名；按出厂 margin 0.03 重放，其中 7 次弃权，有区分度的排名只有 1 次（sel-4fcbc905）；
- legacy 只有合成场景的检测数据（`src/verifier.ts` `divergenceGuardBlocks` 注释：56 行 eval，32 次检测），没有"反馈改善结果"的证据，repair-v2 实验从未执行。

本实验回答两个问题：

- **Q1**：同一个模型、同样的单次 rollout 预算下，"N=2 加 verifier 选择"交付的结果，是否比"单次 rollout"（插件关闭时用户得到的）好到足以抵消成本？
- **Q2**：legacy 的"需要反馈"判定，能否预测单次 rollout 的隐藏测试失败？

## 2. 实验臂

每题三条臂。A 与 B 使用同一 provider 和同一候选模型（`selectionModelStrategy=quality-first`），单次 rollout 超时相同。

| 臂 | 内容 | 对应产品形态 |
|---|---|---|
| A | 1 次 rollout，插件关闭 | 出厂默认（R7 起 `selectionMode=off`） |
| B | 1 次 `selectionMode=always` 选择：N=2、K=1、P=0，`selectionMarginThreshold` 与 `selectionUncalibratedMarginPolicy` 按出厂默认 | opt-in autopilot |
| L | 对 A 的结果事后调用一次手动 `/verify`（5 路 lane，出厂 legacy 阈值，`autoFeedback=false`，所以**不**把反馈发回 agent），记录 `flagged` = 该记录在 `autoFeedback=true` 下**会**发回反馈：`decideFeedback(...).feedback` 为真，且引用审计找到了独立缺陷证据（`src/host.ts` 的反馈分支）。只看 `decideFeedback` 的结果作为次要分析 | legacy 判定质量 |

B 不使用 `auto`：`auto` 的准入是关键词启发式，混入准入率会把"选得好不好"和"准入得对不对"搅在一起。准入率已由 `scripts/tests/product-defaults.test.mjs` 在固定语料上单独记录。

## 3. 题集

- **30 题**，在任何 rollout 之前一次性冻结：任务提示、仓库快照（git fixture）、隐藏测试命令三者的 sha256 写进 `eval/p1/tasks/MANIFEST.json`。题集尚未构建，构建它是执行本实验的第一步。
- 构成：10 题小型修 bug、10 题小功能、10 题带测试的重构。每题应是"一次 agent 回合能完成"的规模，对应 R7 准入语料里的 substantive 类。
- 隐藏测试命令只在事后运行，A、B 都看不到；任务提示里不得出现测试文件路径。
- 冻结之后不得按 A 或 B 的结果删题。基础设施故障（provider 5xx、worktree 失败）在偏差记录中逐条记账，并按同一配置重跑一次；仍失败的题记为 `failed`，计入分母。

## 4. 指标（与 `eval/p1/metrics.mjs` 一一对应）

`computeP1Metrics(rows)`，每题一行：

- `passAt1`：A 的隐藏测试通过率。
- `passSelected`：B **实际交付**候选的通过率。B 没有点名候选时（abstain、insufficient_evidence、verifier_unavailable），source agent 拿到的是候选 0，按候选 0 计，等同于没有 verifier。
- `passRandomPick`：B 两个候选通过率的均值（随机挑一个的期望）。
- `passOracle`：B 中至少一个候选通过的比例（best-of-2 上限）。
- `pipelineUplift = passSelected − passAt1`：整条产品路径相对出厂默认的提升（包含"多跑一次"本身的收益）。
- `selectionUplift = passSelected − passRandomPick`：verifier 本身的贡献。
- 分歧题（discordant）：两个候选在隐藏测试上一过一不过。只有在分歧题上，选择才有对错可言。
- `agreement`：B 在分歧题上给出 `ranked_winner` 时，选中通过者的比例，附 Wilson 95% 区间。分歧题上的弃权单独计数（`abstainOnDiscordant`），不进 agreement 的分母。
- `costMultiplier`：B 的 token 总量（两次 rollout 加 preflight 和 ranking）除以 A 的 token 总量。

`computeLegacyFlagMetrics(rows)`：`precision = P(A 失败 | 被标记)`，`recall = P(被标记 | A 失败)`，`invalidRate` 为 lane 未能给出判定的比例。

## 5. 判定规则（`decideP1`、`decideLegacy`；阈值冻结在 `P1_THRESHOLDS`、`LEGACY_THRESHOLDS`）

**Q1（autopilot）**

- 功效门槛：题数 ≥ 30，且分歧题上给出决定的 ≥ 15。不满足时为 `inconclusive`。
- `stop`（满足功效门槛，且任一条成立）：agreement 区间上界 < 0.6；`selectionUplift ≤ 0`（不比随机挑一个好）；`pipelineUplift ≤ 0`。
- `continue`（以下全部成立）：agreement 区间下界 > 0.5、`pipelineUplift ≥ +0.10`、`costMultiplier ≤ 3`。
- 其余情况为 `inconclusive`。

stop 规则刻意使用点估计：在约 20 道已决定的分歧题上，抛硬币 verifier 的 agreement 区间约为 [0.30, 0.70]，只看区间的 stop 规则永远不会触发，无用的 verifier 会一直停在 `inconclusive`、一直被投入。这是投资决策，不是显著性声明。单测 "a coin-flip verifier is 'stop' even though best-of-2 lifts pass rate" 固定了这一点：N=2 本身会抬高 `pipelineUplift`，所以仅凭它不足以继续。

**Q2（legacy）**

- lane 无效率 > 0.2 时直接 `retire`。此项先于样本量判断：传输不可靠在任何样本量下都不合格，而且会缩小有效集合。
- A 的失败数 < 10 时为 `insufficient`。对"是否默认开启"的问题，按 retire 处理：花钱需要证据，存疑不是理由。
- `keep`：precision ≥ 0.7 且 recall ≥ 0.5。否则为 `retire`。

## 6. 结果对应的行动

| Q1 | 行动 |
|---|---|
| continue | 负责人可以考虑把 `auto` 作为推荐设置写进 README；是否改回默认开启需要另行决定，并先用 R7 语料把 `auto` 准入的误收（纯提问、小改动）降下来 |
| inconclusive | 题集扩到 60 题（同一套规则）**一次**；仍然 inconclusive 就按 stop 处理 |
| stop | 停止 selection 功能投入；代码保留为 opt-in，只做维护性修复 |

| Q2 | 行动 |
|---|---|
| keep | 保留 idle 路径（仍为 opt-in） |
| retire / insufficient | 删除自动触发（`enabled`、`skipStatusContinuation`、`handleStatus` 中的 `scheduleAuto`），以及发回 agent 的反馈分支（`autoFeedback`、`maxFeedbackPerSession`）。保留 lane 执行与记录上的判定标签，手动 `/verify` 和 `/eval` 依赖它们（范围见 R7 备忘录 §8） |

## 7. 样本量与预算

- 30 题：A 30 次 rollout；B 60 次 rollout，加 180 次 ranking 调用（每次选择 2 个有向对 × autopilot 固定的 3 条 criteria × K=1 = 6 次，见 docs/VERIFIER-SCHEDULER.md 的调用数恒等式；preflight 另计，成功结果缓存 30 分钟）；L 150 次 lane 调用。
- 单次 rollout ≤ `selectionCandidateTimeoutMs`（出厂 600 s）。
- 硬上限：rollout 总数 ≤ 100，verifier 加 lane 调用总数 ≤ 450。超出即停，已有数据只作描述，不做判定。

## 8. 止损规则

- 前 10 题中，B 有 ≥ 5 题以 `verifier_unavailable` 或 `failed` 结束：暂停，先修复传输，作为偏差记账后从头开始。
- 前 10 题中分歧题为 0：暂停，并记录"题集太易或太难"。可以替换题集**一次**（重新冻结 MANIFEST），替换题集不得参考 B 的任何选择。

## 9. 分析计划

- 主分析只运行 `computeP1Metrics`、`decideP1`、`computeLegacyFlagMetrics` 和 `decideLegacy`，输出原样写进结果文件（`eval/p1/results/<date>.json`），并在本文追加"结果"一节。
- 次要分析（只描述，不进判定）：忽略 margin 门槛时排名第一的候选的 agreement（衡量门槛的代价）；按题型分组的各项指标。
- 不做多重比较校正。判定只有上面两条规则。

## 偏差记录

（执行后追加。）

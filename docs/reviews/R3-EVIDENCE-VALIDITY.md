# R3 审查报告：证据与度量有效性

- 基线：`442543f`（R2 之后），审查分支 `arena/01a0d1de-dsh-verifier-autopilot`，PR #5
- 计划：`docs/REVIEW-PLAN-2026-09-24.md` §R3
- 提交：`c3006a3` `9829e3f` `f50d059` `da8fce8` `5e4e9e2` `f91c070` `8ea45c9`
- 回归测试：`scripts/tests/evidence-validity.test.mjs`，共 18 个测试，其中 3 个端到端测试跑在真实 git worktree 上。另外 `autopilot.test.mjs:244` 和 `bridge.test.mjs` 各补了断言，见 §7
- 门禁：`check:architecture`、`typecheck`、`build:host`、`build:client` 全绿；`npm test` **289/289**（R2 之后 271，新增 18）；`bridge/self_test.py` 13 PASS / 1 SKIP；`git diff --check` 干净；每次推送两路 CI（push 和 pull_request）全绿
- 约束：本轮没有产生任何 provider 调用。所有校准相关结论都来自 invoice 里已有的数字、上游源码（`llm-as-a-verifier` `8db8a11`）和离线模型

## 1. 目标与方法

项目的标准是“只信已证实的事实”。本轮逐条审计现有结论背后的证据链：margin 门的校准、交付审计（`delivered`）、调度恒等式，以及两套打分实现。做法：

1. **先复现。** 在基线（`442543f` 的 worktree 构建）上跑同一份测试文件，拿到修复前的真实输出（§4）。
2. **对照上游源码推导度量语义。** 读 `pivot_tournament.py` 的 ring/BT/`w/c`、`directed_reward` 在 K 次重复里奇数次交换槽位、`extract_score` 的回退分支，确认 margin 在不同 N/C/K/P 下的零分布到底是什么。
3. **无法花钱实测的，用离线模型量化。** `eval/calibration/null-model.mjs` 逐行复刻生产聚合，并把采样噪声拟合到 invoice 的数字上：模型给出 240 帧 C0 最大值 0.01381，invoice 实测 0.01377。
4. **修复改的是证据来源和标注，outcome 集合不动。** 只有在运营者显式选择时，行为才会变得更保守（`selectionUncalibratedMarginPolicy: abstain`）。

## 2. 发现与处置

| # | 严重度 | 发现 | 处置 | 位置 |
|---|---|---|---|---|
| 3.3 | **高** | 交付审计被混淆。旧的判定是 `headChanged \|\| dirty > 0` 就算“已集成”：(a) 没有 dirty 基线，用户原本就有的未提交改动也算进去；(b) HEAD 在 selection 开始时采样，源 turn 并发做的改动也算进去；(c) 从不检查 winner 的内容是否真的出现在源里。基线上，一个**什么都没集成**的脏仓库会被审成 `delivered: "yes"`，而且测试命令照样在用户仓库里跑了 | relay 前做快照，按字节比对“候选自己改过的文件”是否被采纳（§3）；测试只在确实观察到采纳时才跑 | `host.ts` `snapshotSourceAtRelay`、`cleanupAutopilotWinnersOnce`；`live.ts` `adoptionOf`；`candidates.ts` `evaluateDelivery` |
| 3.7 | **高**（新） | `prepare()` 把源仓库的未提交改动镜像进每个候选，但不提交。于是 `git diff HEAD` 把用户的在制改动算成**每个**候选的工作：什么都没干的候选能通过 has-work 门，这些改动也会被写进 verifier 前言（“Worktree diff vs source HEAD”）。基线上，一个 idle 候选得到 `files:1, untracked:1` | 每个 worktree 在准备时把当时的状态记为起点基线（写在 worktree 私有的 git dir 里）。`gitDiffStat` 只统计候选自己的变更，另记 `inherited` 条数；前言改为“Worktree changes made by this candidate … N inherited … NOT counted” | `live.ts` `captureWorkspaceBaseline`、`candidateOwnChanges`、`gitDiffStat`；`candidates.ts` 前言 |
| 3.7b | 中（新） | R2 的内容指纹在子目录 cwd 下会读错文件：`diff --name-only` 给出的是仓库根相对路径，`ls-files --others` 给出的是 cwd 相对路径，两者直接拼到 cwd 上 | 两条 git 列表都在仓库根执行，路径一律用根相对 | `live.ts` `workspaceEntries` |
| 3.8 | 中（新） | `relayedAt` 从来没有落到最终记录上。runner 最后一次 `onUpdate` 把终态复制到 placeholder，`waitFor` 就带着 placeholder 返回了；随后 `finishRun` 用 runner 自己的记录对象替换掉它。relay 写在一个已经脱离列表的对象上，`pubRecord` 会静默忽略。ledger 的最后一行没有 `relayedAt`，进程在 relay 之后、idle 之前非正常退出，重启后的恢复逻辑会**把同一条 relay 再发一次**（基线实测：2 次） | `waitFor` 改为等 run 离开 `active` 之后才算 settled，这时拿到的就是最终记录对象 | `selection/host.ts` `waitFor` |
| 3.1 | 高 | 0.03 只在**一个**条件下测过：kimi-k3@low、N=2、C=1、K=1、P=0、合成短 fixture。出厂默认的每一维都不同：verifier nemotron（0 轮）、autopilot C=3、deep 模式 N=3/K≥2、输入是前言加最多 24k 字符的真实轨迹。记录里 `marginCondition` 只有 `model@effort`，relay 却无条件写 “cleared the margin gate” | 条件注册表加上 `marginCalibration` 标注；默认策略 `flag`，可选 `abstain`；relay 按条件改写措辞（§5） | `selection/calibration.ts`、`candidates.ts`、`autopilot.ts`、`config.ts` |
| 3.2 | 高 | C0 拿候选和**自己**比：(A,B) 与 (B,A) 是同一个 prompt，只能测采样噪声。两段不同文本之间的顺序效应，C0 结构上看不见（§6）。invoice 的 “位置偏置 ≤0.005” 这一毕业条件同样是结构上必然成立：ring 让恒定槽位偏置 β 在 C0 里抵消，β=0.2（4 个档位）时信号均值仍然 ≈0 | `null-model.mjs` 把后果量化；`run.mjs` 增加可选的 C3 组（等证据的改写对，`CAL_C3_REPS`，默认关闭），并附带一个经过验证的 σγ 上界估计器 | `eval/calibration/null-model.mjs`、`run.mjs` |
| 3.4 | 中 | 恒等式 `usage.calls == nComparisons×C×K` 只写进文档，从不校验 | 核对上游后确认：在 `on_error=raise` 的成功路径上，这个等式应当严格成立（USAGE 只计成功响应，429 重试发生在同一次计数调用内部）。不相等时记录 `verifierCallsAnomaly` 并计入诊断，不改变 outcome | `candidates.ts` |
| 3.5 | 中 | 两套打分实现。朝向和刻度一致（A→1、T→0、步长 1/19），规范标签查找也一致（TS 的 `distributionAt` 是上游 `_find_tag_logprobs` 的忠实移植）。分歧在于：(i) 裸 `score_A>` 只有 sidecar 补丁接受；(ii) 小写字母 token 只有上游计入；(iii) **失败语义不同**：TS 遇到无分布或无标签直接失败（除非 `allowLabelFallback`），上游**静默**退回字面字母，或者直接返回 0.5。`on_error=raise` 捕不到后者。只要一侧槽位退回 0.5 而另一侧是真实分数，就会凭空产生偏好（例如 R_b=0.9 对 R_a=0.5，p≈0.40） | sidecar 对每次 `extract_score` 分类计数（logprobs / literal / default），随结果返回；记录为 `scoreExtraction`，relay 里点名。测试用的是上游提取器的逐字拷贝（fake `llm_verifier` fixture） | `bridge/llm_verifier_sidecar.py`、`bridge.ts`、`PROTOCOL.md` |
| 3.6 | 低 | `run.mjs` 写死了 `C:/Users/Admin/...` 和中转地址，两个 smoke 脚本同样如此；`graduate.mjs` 写死 0.03；`eval/run.mjs` 写死 `127.0.0.1:3080`，而且发不出 R1 的 token；校准 README 还写着 0.08；`crossRound` 仍在执行已经废止的 “q95 相差 20%” 规则 | 新增 `eval/lib/env.mjs`：凭据路径取 `DSH_CREDENTIALS` 或 `~/.dsh`，端点取 `KIMI_BASE_URL` 或插件默认 baseURL。阈值取自 `DEFAULT_SELECTION_MARGIN_THRESHOLD`；`DSH_VA_API_BASE`/`DSH_VA_API_TOKEN` 改为从环境读取；删掉 q95 规则；run.mjs 的默认模型改为唯一还在积累证据的 kimi-k3。加了守卫测试，防止这些写死回流 | `eval/*` |

## 3. 3.3 的归因方案

**问题的本质：** “源仓库变了”不等于“源仓库采纳了 winner”。能归因到 relay 的证据只有一种：**winner 自己改过的文件，relay 之后以字节级一致的形式出现在源里，而 relay 时还没有。**

**采集（`snapshotSourceAtRelay`，在 relay 之前 await）：**
- 源的 `HEAD`，以及源工作区的内容指纹（所有变更文件和未跟踪文件的内容摘要）；
- `adoptionOf(winner, source)`：winner 的**自有变更**（相对它自己的起点基线，因此不含继承来的用户改动）里，哪些在 relay 时已经与源字节一致。这些文件记为 `adoptedPaths`，之后不计入新采纳。

**审计（源 idle 或 dispose 时，discard 之前）：**
- `adoptedNew` = 当前已采纳文件 − relay 时已采纳文件；
- `changedSinceRelay` = HEAD 或指纹相对快照是否变化。

| 条件 | `delivered` | `basis` |
|---|---|---|
| `adoptedNew > 0`，配置了测试且 exit 0 | yes | relay-adoption |
| `adoptedNew > 0`，没有配置测试 | unknown | relay-adoption |
| `adoptedNew > 0`，测试失败 | no | relay-adoption |
| `adoptedNew = 0` 且源在 relay 后变过 | unknown（重新实现或无关改动，无法归因） | relay-adoption |
| 源在 relay 后没有变化 | no | relay-adoption |
| 采纳情况测不出来（非 git、快照失败） | unknown | relay-adoption |
| 没有 relay 快照的老记录 | 旧语义，note 标明“start-time baseline: not attributable to the relay” | start-baseline |

后置测试（`selectionPostAuditTestCommand`）**只在 `adoptedNew > 0` 时**才在用户仓库里运行。旧代码只要 HEAD 变过或工作区是脏的就会跑。

**记录字段：**
- `sourceAtRelay {at, head, worktreeFingerprint, adoptedPaths, candidateFiles, concurrent?, error?}`
- `delivery.basis`
- `delivery.changedSinceRelay`
- `delivery.adoptedFiles`（上限 50 条）
- `delivery.candidateFiles`

**时序：** relay 现在要等快照完成之后才发出，因此 `autopilot.test.mjs:244` 改为等待 relay followup，而不是在 settle 的同一个 tick 里断言。重载恢复路径的 `start()` 是同步的，快照只能和 relay 并发采集，记录上会带 `concurrent: true`。

## 4. 修复前后的行为证据

同一份 `evidence-validity.test.mjs`，分别跑在基线构建（`442543f`）和本轮构建上：

| 场景 | 基线 | 本轮 |
|---|---|---|
| 脏仓库里什么都没做的候选 | `{"files":1,"insertions":1,"untracked":1}`，has-work 门**通过** | `{"files":0,"untracked":0,"inherited":2}`，门不通过 |
| 子目录 cwd 下 idle 候选的变更数 | 1（继承来的改动被当成候选工作） | 0 |
| 源是脏的（用户在制改动）、没有集成任何东西、配置了测试命令 | `delivered: "yes"`，并且在用户仓库里跑了测试（`postAuditTestExit: 0`） | `delivered: "no"`，`basis: relay-adoption`，没有跑测试 |
| relay 后源 turn 自己写了一个无关文件 | `delivered: "yes"` | `delivered: "unknown"`，`changedSinceRelay: true` |
| relay 后源拷入 winner 的 `pass.txt` | （无法区分） | `delivered: "yes"`，`adoptedFiles: ["pass.txt"]`，`candidateFiles: 1` |
| ledger 最后一行的 `relayedAt` | `null` | 有值 |
| relay 后、idle 前进程崩溃，重启恢复 | 源 agent 收到**2 次**同一条 relay | 1 次 |
| 非校准条件下的 ranked_winner relay | “cleared the margin gate” | “exceeded the margin threshold, but that threshold was NOT calibrated for this condition (differs in: inputs=production-trajectory) …” |
| `usage.calls` 与期望不符 | 不记录 | `verifierCallsAnomaly {expected, observed}` |
| verifier 回复无法解析，上游退回 0.5 | 不可见 | `scoreExtraction.default` 加 1，relay 点名 |

## 5. 3.1 决策

**已落地：** 条件注册表（`src/selection/calibration.ts`）。

- **条件键：** `verifier@effort | N | C | K | P | inputs`。这六维的每一维都会改变 margin 的零分布：N=2 时双向比较，N≥3 且 P=0 时每对只比一个方向，top-2 差是一个次序统计量；C×K 决定平均的次数；K≥2 会在比较内部交换槽位；输入长度和分布也有影响。
- **注册表内容：** 目前只有一条，即 invoice 第 2–5 轮的 kimi-k3@low、N=2、C=1、K=1、P=0、`synthetic-short`，状态 provisional，240 帧，最大值 0.01377。
- **记录：** 每条 ranking 写入 `marginCalibration {status, key, nearest, mismatches[], policy, forcedAbstain?, thresholdMismatch?}`。生产 runner 的输入永远是 `production-trajectory`，所以**今天的每一次生产选择都是 uncalibrated**。这是如实的结论，不是实现缺陷。
- **策略 `selectionUncalibratedMarginPolicy`：**
  - `flag`（默认）：门限照常起作用，但记录和 relay 会说明未校准以及差在哪几维，relay 把它称为“误选率未知的弱相对偏好”。
  - `abstain`：未校准的条件下不产出 verifier winner。
- **为什么不是“按条件查阈值”：** 能查的条件只有一个，查了等于没查。注册表里的 threshold 用于核对：若命中的条目阈值与实际使用的不一致，记 `thresholdMismatch`。运营者配置的 `selectionMarginThreshold` 仍然是唯一生效的阈值。
- **为什么默认不强制 abstain：** 在现有证据下，强制 abstain 等于关掉所有 verifier winner。这属于产品默认值的变更，和 R1 的 1.1、1.9 一样交给负责人决定。**建议：** 在为默认 verifier 跑出一轮 C3 加生产长度输入的校准之前，保持 `flag`；想要严格语义的运营者可以立即改成 `abstain`。

## 6. 3.2 定量：C0 看不见什么

模型（`null-model.mjs`，每格 20000 次）：所有候选质量相同，因此任何越过 0.03 的结果都是误选。σγ 是“两段不同文本在特定顺序下的系统偏移”，对同一个 prompt 的每次重采样都相同，C0 无法观测它。σ_η=0.0129 按 invoice 拟合。

| 条件 | σγ=0 | 0.025（半档） | 0.05（一档） | 0.1（两档） |
|---|---|---|---|---|
| 已校准：N=2 C=1 K=1 | 0.00% | 0.21% | **9.87%** | 39.68% |
| autopilot standard：N=2 C=3 K=1（各准则的偏移独立） | 0.00% | 0.00% | 0.40% | 14.49% |
| 同上，偏移在各准则间共享（悲观情形） | 0.00% | 0.14% | **9.65%** | 39.55% |
| autopilot deep：N=3 C=3 K=2 | 0.00% | 0.00% | 0.00% | 0.27% |
| N=3 C=1 K=1 | 0.00% | 0.01% | 1.67% | 19.75% |

**读法：**

1. **0.03 足以挡住采样噪声，但它挡不挡得住顺序效应，取决于一个从未测过的量。** σγ 达到一档时，已校准条件的误选率约 10%。
2. C=3 的保护作用依赖“各准则的偏移相互独立”这一假设；如果偏移在准则之间共享，C=3 就退化成 C=1。
3. deep 模式因为 K≥2 会在比较内部交换槽位，σγ 大部分被抵消。
4. **修正我在计划里的一个假设：** 在 ring 聚合下，N=3 的零分布比 N=2 **更窄**，不是更宽：三个分数共享比较，它们的 top-2 间距更小。结论依然是 N=3 属于不同的条件，但方向是门限在那里更保守。
5. **输入偏移的代理：** 把 σ_η 放大 3 倍时，已校准条件的误选率为 2.71%，autopilot standard 为 0.01%。这是纯粹的假设，真实值只能通过 C3 或生产长度输入实测。

**下一步可以直接执行的 round6 配方：**

```
CAL_MODEL=kimi-k3 CAL_EFFORT=low CAL_C0_REPS=12 CAL_C3_REPS=10 CAL_LABEL=round6 node eval/calibration/run.mjs
```

summary 会给出 `c3.sigmaGammaUpper`，把它代入上表即得误选率上界。这个估计器已在测试里验证：真实 σγ=0.05 时能还原到 0.04–0.06 之间，σγ=0 时 <0.012。

## 7. 有证据 / 无证据对照表

| 结论（出处） | 状态 | 证据或缺口 |
|---|---|---|
| verifier 能区分明显的好坏（README、invoice C1/C2） | **有证据，限定条件** | kimi-k3@low、合成 fixture：C1 12/12，C2 12/12（最小 margin 0.385）。nemotron 和真实轨迹都没有测过 |
| 0.03 ≈ 2.17 倍噪声上限（config、invoice） | **有证据，限定条件** | 240 帧 C0，最大值 0.01377，单一条件；仍为 provisional（“≥2 个自然日”未满足） |
| “流水线不会凭噪声静默地宣布 winner”（README 第 9 行） | **只对采样噪声成立** | 顺序效应 σγ 未测（§6）；上游静默的 0.5 替代此前不可见（3.5，现已可见）；每一个生产条件都未校准（3.1，现已标注） |
| 默认 verifier nemotron 适用 0.03 | **无证据** | 0 轮校准；现在每条记录都会标出 `verifier` 这一维不匹配 |
| 位置偏置 ≈0（invoice 毕业条件 4） | **结构上必然成立，不构成证据** | ring 在 C0 里抵消恒定槽位偏置，β=0.2 时信号均值仍 ≈0。好在排序同样受 ring 保护，这个条件不需要，但也不能当作测量结果引用 |
| 校准结论可以在 TS legacy 栈和 Python 选择栈之间迁移 | **无证据** | 失败语义不同（3.5）；校准只覆盖 Python 栈 |
| N=3 或 deep 模式下 0.03 同样合适 | **无实测，模型显示更保守** | §6 模型；依赖 σγ 和准则独立性假设 |
| `delivered=yes` 表示 winner 被集成且通过测试（旧语义） | **反例已复现** | 什么都没集成的脏仓库被审成 yes（§4） |
| `delivered=yes` 表示 winner 的字节被采纳且测试通过（新语义） | **有证据** | 端到端测试覆盖 yes/no/unknown 三种路径；残余风险见 §8 |
| has-work 门和去重反映的是候选自己的工作 | 旧：脏仓库下**不成立**；新：**有证据** | §4 前两行 |
| 调度恒等式成立 | **现在会逐条核对** | 历史 ledger 不在仓库里（`.data/` 被 gitignore），没有回溯 |
| 重载恢复是幂等的 | 旧：**不成立**；新：**有证据** | §4 relay 次数一行 |
| selection 能提升最终交付质量（README 自认未证明） | **仍无证据** | 新的 `relay-adoption` 口径让“采纳率”第一次可以测量，但还没有数据 |

## 8. 残余风险

- `gitDiffFull` 生成的审计包补丁仍然包含继承来的用户改动（只影响审计包展示，不影响任何判定）。已登记给 R5。
- 对 baseline 里已经是脏状态的路径，insertions/deletions 是相对 HEAD 计算的，是近似值；has-work 门只看文件数，不受影响。
- 采纳要求字节完全一致：候选内容经过 autocrlf 转换、格式化或者被部分采纳，都会落到 `unknown`（偏保守）。超出摘要预算只记了大小的文件，以及候选“还原到 HEAD”的路径，不参与采纳判定。
- 重载恢复路径的快照与 relay 并发采集（`concurrent: true`），严格说不是 relay 之前的状态。
- `scoreExtraction.default > 0` 目前只记录不改变 outcome。是否应当强制 abstain，属于默认值决策，建议与 3.1 的策略一并交给负责人。
- 条件键里的 `inputs` 只有两个取值，它区分的是来源类别，不是长度分布。等真正有了生产长度的校准数据，再细分。
- null model 假设噪声是高斯分布、σγ 在各个 pair 之间独立同分布；它是量级论证，不能替代 C3 实测。
- C3 fixture 属于“等证据”的改写，不保证质量完全相等，所以估计器给出的是上界。

## 9. 兼容性影响

- **新配置项：** `selectionUncalibratedMarginPolicy`（`flag` | `abstain`，默认 `flag`），未加入特权字段，与 `selectionMarginThreshold` 同级。
- **新增记录字段（全部可选，老 ledger 可以照常读取）：** `marginCalibration`、`verifierCallsAnomaly`、`scoreExtraction`、`sourceAtRelay`、`delivery.{basis, changedSinceRelay, adoptedFiles, candidateFiles}`、`DiffStatLite.inherited`。
- **协议：** select 结果多了可选的 `extraction`（`PROTOCOL.md`、fixture、stub 已同步）；老版本 sidecar 不返回这个字段，host 端会把它当作缺省处理。
- **行为变化（均为更保守或更准确的方向）：**
  - relay 措辞按校准状态变化；
  - 交付审计从“源有变化”改为“源采纳了 winner 的字节”；
  - 后置测试只在观察到采纳时才运行；
  - 在脏仓库里什么都没做的候选，不再能通过 has-work 门；
  - relay 要等快照完成后才发出，通常多出几十毫秒的 git 调用。
- **测试改动：**
  - `autopilot.test.mjs:244` 改为等待 relay followup，并新增断言：快照存在、`relayedAt` 落在存储的记录上；
  - `bridge.test.mjs` 的规范结果包含 `extraction`；
  - 原有的其他测试一条都没有改。

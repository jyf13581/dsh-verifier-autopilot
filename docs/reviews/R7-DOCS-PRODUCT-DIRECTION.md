# R7 决策备忘录：文档真实性与产品方向

- 范围：README.md、HANDOFF.md、docs/ARCHITECTURE.md、API-BOUNDARY-DECISIONS.md、bridge/PROTOCOL.md、docs/VERIFIER-SCHEDULER.md、eval/calibration/README.md；`src/config.ts` 默认值；`src/selection/autopilot.ts` 准入；`src/host.ts` legacy idle 路径；`.data/selections.jsonl` live ledger
- 基线：`c32aa59`（R6 收尾）
- 结果：全部测试通过（数量以 CI 输出为准；本轮新增 15 个），`check:architecture`、`check:contract`、`typecheck` 通过，`bridge/self_test.py` 通过
- 回归测试：`scripts/tests/product-defaults.test.mjs`（7.2/7.3 默认值、准入画像、每回合花费）、`scripts/tests/doc-truth.test.mjs`（7.1 生成块与文档 lint）、`scripts/tests/p1-metrics.test.mjs`（P1 判定规则）
- 提交：`9402d19`，以及本备忘录所在的文档提交
- 负责人决定（2026-10-09，审查中经 ask_user 确认，符合计划规则 4）：`selectionMode` 默认 `off`；legacy `enabled` 默认 `false`（保留代码、`/verify`、`/eval`）；HANDOFF 原地降级

## 1. 结论（先读这一节）

1. **两条花钱路径都改为显式 opt-in。** 仓库没有任何证据证明它们改善了交付结果（§5），而开启的成本是确定的（§4）。改动只涉及两个默认值，代码路径不变，opt-in 后行为与 R6 一致。
2. **继续投入的判据是 P1 固定小题集**（`eval/experiments/p1-fixed-set.preregistration.md`）：30 题，A（单次 rollout）对比 B（N=2 加 verifier 选择），另加 oracle best-of-2。判定规则是代码（`eval/p1/metrics.mjs`），在任何数据出现之前由单测固定。
3. **legacy：冻结，等 P1 的 L 臂结果决定是否退役自动 idle 路径。** 推荐预期是退役（§8）。手动 `/verify` 保留。
4. **文档以代码为准。** README 的默认值和限额表由 `scripts/doc-facts.mjs` 从配置 schema 生成，过期时 `npm test` 失败；权威文档禁止手写测试数、本机路径和与代码不符的默认值（`doc-truth` lint）；测试数只看 CI。HANDOFF 改为运维日志，不再是权威文档。

## 2. 发现与处置

| # | 发现 | 处置 | 测试 |
|---|---|---|---|
| 7.1 | 文档与代码多处不一致（§3）：README 手写测试数（191/191、"203 regressions"），校准阈值写成 0.08，有一处本机路径；HANDOFF §2「当前生产契约」被代码注释引用，但与代码有 6 处矛盾 | README 默认值表改为生成；旧状态段移到 `docs/STATUS-HISTORY-2026-09.md`；HANDOFF 加权威性横幅，修正 §2 的矛盾，§4 手写表换成指向生成表的说明；VERIFIER-SCHEDULER 的本机参考树改为上游仓库链接，并在 `90e8fc2` 上核对了所引函数的行号 | `doc-truth`：生成块逐字一致；6 份权威文档 lint 为零；4 类负对照；R7 之前的 README 必须被 lint 拦下 |
| 7.2 | `selectionMode=auto` 默认开启：每个被准入的回合多跑 2 个全权限 rollout，外加 6 次 ranking 调用；准入是关键词启发式，会接纳纯提问和小改动（§4） | 默认改为 `off`（负责人决定）；准入画像固定在测试里，以后改启发式会表现为画像的 diff | `product-defaults` 1、2 |
| 7.3 | legacy `enabled=true` 默认开启：每个通过门控的 idle 回合调用 5 条 lane；`autoFeedback=false` 是默认值，所以结果只写进 `records.jsonl` 和 GUI，agent 看不到 | 默认改为 `false`（负责人决定）；花费固定在测试里：默认 0 次调用，opt-in 后 5 次调用、0 次 follow-up、1 条记录 | `product-defaults` 3、4 |
| 7.4（新） | **没有任何测试固定 `enabled` 或 `selectionMode` 的默认值**：R6 的 329 个测试在改默认值前后全部通过。改一个产品级默认值不会让任何门禁变红 | `product-defaults` 1、3 固定两个默认值。已验证：把 `src/config.ts` 换回 `c32aa59` 版本后，这两个测试失败 | `product-defaults` |
| 7.5（新） | 预注册的判定规则本身有两个缺陷，写测试时发现：(a) 只用区间的 stop 规则在 20 道分歧题上永远拒绝不了抛硬币 verifier，无用的 verifier 会一直"inconclusive"、一直被投入；(b) lane 大量失败时，失败题也会从有效集合中消失，判定变成"样本不足"，不可靠的传输被掩盖 | (a) stop 增加点估计规则 `selectionUplift ≤ 0`；(b) 先判无效率，再判样本量 | `p1-metrics` 2、6 |
| 7.6（新） | README 的 `/select` 限额（12/小时）手写在正文里 | 改为指向生成的限额表（数值来自 `API_RATE_LIMITS`） | `doc-truth` 1 |

## 3. 文档漂移清单（修复前后）

扫描对象是仓库里除 `docs/reviews/` 外的全部 `.md`；"修复后"由本轮随代码发布的 `lintDoc` 统计。

| 类别 | 修复前 | 修复后：权威文档 | 修复后：非权威文档（日志与历史，不 lint） |
|---|---|---|---|
| 手写测试数 | 15（README 2、HANDOFF 6、HANDOFF-HISTORY 6、计划 1） | **0** | HANDOFF 6、HANDOFF-HISTORY 6、STATUS-HISTORY 2（自 README 迁出）、计划 1 |
| 本机路径 `C:/`、`D:/` | 34（HANDOFF 19、HANDOFF-HISTORY 10、API-BOUNDARY-HISTORY 3、README 1、VERIFIER-SCHEDULER 1） | **0** | HANDOFF 20（§4 新增一行说明运维 Python 路径）、HANDOFF-HISTORY 10、API-BOUNDARY-HISTORY 3、计划 3、STATUS-HISTORY 1 |
| 与代码不符的默认值 | 15（HANDOFF 13） | **0** | 0（HANDOFF §4 手写表已移除） |
| 与出厂门槛不符的 margin 数 | 18 | **0** | HANDOFF 12、STATUS-HISTORY 4（历史上的 0.08 和校准中间值） |

HANDOFF §2 被代码以 `HANDOFF §2.x` 引用，所以单独核对了一遍，修正了以下与代码的矛盾：

- §2.4：5 条要点逐字重复（preflight memo、deadline、workers、默认值、effort），已删除重复，两种 timeout 写法合并为较新的一种。
- §2.4："P 缺省时 fallback 为 1"已改为 `DEFAULT_SELECTION_PIVOTS`=0（R6 6.3）。
- §2.4："Kimi verifier maxWorkers=1"已改为 `selectionVerifierWorkers` 0=auto（`AUTO_VERIFIER_WORKERS`=4）。
- §2.5："当前没有后置审计器"与同节的 G-4 delivery audit 矛盾，已改为"G-4 只记录，不强制履约"。
- §2.1：补上 `selectionMode` 默认 `off`，以及 auto 准入画像。
- §4：lane maxTokens 写作 8192，代码为 64000；整张手写表已移除。

另外，HANDOFF 顶部快照第一段（`enabled=false`、`selectionMode=off` 是既定 live 态）和第二段（持久层 `selectionMode=always`）互相矛盾。两者都未经核实，横幅中注明以 live `/state` 为准。§2 里还剩 1 处本机路径（§2.5 中 2026-09-05 修复记录里的举例），它是事件记录，不是契约，保留。

## 4. 成本模型

**opt-in `auto`，每个被准入的回合**（出厂 N=2、K=1、P=0）：

- 2 次全权限候选 rollout，每次最长 `selectionCandidateTimeoutMs`（600 s），各自在独立 worktree 中运行；
- ranking：2 个有向对 × 3 条 criteria × K=1 = **6 次 verifier 调用**（docs/VERIFIER-SCHEDULER.md 的调用数恒等式）；
- 缓存冷时另加：候选模型 1-token 探活，以及 verifier preflight（成功结果缓存 30 分钟）；
- source agent 之后还要 finalize（读两个候选、合并、跑测试）；
- deep 档（N=3、K≥2）为 3 次 rollout 和 30 次以上调用。在 40 条语料里，auto 没有准入任何 deep 回合。

**准入画像**（40 条标注语料，`scripts/tests/fixtures/admission-corpus.mjs`；画像固定在 `product-defaults` 2）：

| 类别 | 运营者期望 | auto 准入 | 产生的 rollout |
|---|---|---|---|
| chat（"thanks"、"继续"） | 什么都不做 | 0/10 | 0 |
| question（纯提问） | 回答，不 rollout | **5/10** | 10 |
| trivial（一处显而易见的小改动） | 直接改 | **6/10** | 12 |
| substantive（开放式工作） | 值得多次独立尝试 | 10/10 | 20 |

被准入的提问举例："Why is the test suite slow?"、"How do I run the tests for just one file?"、"这个仓库的代码结构是怎样的？"、"Is there an API to list selections?"。被准入的小改动举例："Add a trailing newline to package.json"、"Add a .gitignore entry for coverage/"、"删除 src/api.ts 里多余的 console.log"。按这份语料，auto 产生的 rollout 中有 22/42（52%）花在了运营者不想要 rollout 的回合上。

反向也有误判："What is the difference between release and discard?" 因为含 "release" 被判为 `external-side-effect-risk` 而拒绝。这类误判只是少花钱，无害。

**opt-in legacy，每个通过门控的 idle 回合**：

- 5 次 lane 调用，每次最长 180 s、64000 tokens；
- 出厂 `autoFeedback=false`：0 次 follow-up，agent 看不到任何结果。花费只换来一条 `records.jsonl` 记录和 GUI 中的一行。

## 5. 价值证据（现有的全部）

- **selection live ledger**（作者机器，`.data/selections.jsonl`）：31 次运行，其中 16 completed、10 failed、5 aborted。只有 8 次产生了真实排名；按出厂 margin 0.03 重放，其中 7 次 `abstain`，有区分度的排名只有 1 次（sel-4fcbc905）。8 个 winner 工作区中有 7 个已被回收。这些数据没有隐藏测试，无法回答"选中的是否更好"。
- **margin 门槛**：R3 3.1 指出，0.03 只在一个条件下校准过；null-model 假赢率为 9.9%。C3 实测配方已写好但没有跑。
- **legacy**：只有合成场景的检测数据（`src/verifier.ts` 的 `divergenceGuardBlocks` 注释：上线前在 56 行 eval 上模拟，压掉 6/6 误报，同时 0/32 漏检）。这证明的是"在人为注入缺陷的场景里能报警"，不能证明"在真实任务上，反馈让结果变好"。repair-v2 实验（旧的 feedback 路线）的预注册明确写着不执行。
- **结论**：两条路径都没有 P1 意义上的证据（同一任务，有和没有插件，用隐藏测试判对错）。

## 6. 本轮改动的产品默认值

| 键 | R6 | R7 | 依据 |
|---|---|---|---|
| `selectionMode` | `auto` | `off` | 负责人决定。改 `auto` 或 `always` 为显式 opt-in；GUI 开关和 `/select` 不变 |
| `enabled` | `true` | `false` | 负责人决定。保留代码、手动 `/verify`、`/eval` |

已核对两个开关的作用范围：`selectionMode` 只在 `src/host.ts:238`（autopilot 的回合钩子）中检查，`enabled` 只在 `src/host.ts:782`（idle 钩子）中检查。手动 `/select`、`/verify`、`/eval` 不受影响。

## 7. P1：继续投入的判据

全文见 `eval/experiments/p1-fixed-set.preregistration.md`，判定代码见 `eval/p1/metrics.mjs`。

- 30 题，在任何 rollout 之前冻结（提示、仓库快照、隐藏测试三者的 sha256），构成为修 bug、小功能、带测试的重构各 10 题。
- 三条臂：A 单次 rollout（等于出厂默认）；B `always` N=2，出厂 margin；L 对 A 的结果事后跑一次 legacy `/verify`。
- **continue**：已决定的分歧题 ≥ 15、agreement 下界 > 0.5、`pipelineUplift` ≥ +10pp、成本 ≤ 3 倍。
- **stop**：agreement 上界 < 0.6，或 verifier 不比随机挑一个好（`selectionUplift ≤ 0`），或整体不比单次好。
- inconclusive 时扩到 60 题，只扩一次；仍然 inconclusive 就按 stop 处理。
- 预算硬上限：100 次 rollout，450 次 verifier 与 lane 调用。
- 题集尚未构建。构建和执行都需要负责人批准花费（§10）。

计划原文要求比较 pass@1、pass@N 和 verifier 与 oracle 的一致率，这里分别对应 `passAt1`、`passOracle` 和 `agreement`。此外增加了 `selectionUplift`：N=2 本身就会抬高通过率，只看 `pipelineUplift` 会把"多跑一次"的收益算到 verifier 头上（见 `p1-metrics` 测试 2）。

## 8. legacy 的保留或退役建议

**推荐：冻结。若 P1 的 L 臂不是 `keep`，则退役自动 idle 路径。**

理由：

- 两条路径并行维护的代价是实际存在的：legacy 有 12 个专用配置键（`enabled`、`autoFeedback`、`routes`、`scoreThreshold`、`disagreementThreshold`、`maxFeedbackPerSession`、`timeoutMs`、`maxTokens`、`temperature`、`divergenceGuard`、`divergenceGuardMedian`、`skipStatusContinuation`，外加 `verifierSmallModel`），还有调度器的 auto 队列、回合门控、引用审计和反馈配额。
- 出厂组合（`enabled=true` + `autoFeedback=false`）是只花钱、不影响 agent 的形态，任何用户都得不到收益。
- 唯一的证据来自合成场景，见 §5。

保留条件（`decideLegacy`）：无效率 ≤ 0.2，A 失败 ≥ 10 题，precision ≥ 0.7，recall ≥ 0.5。

退役范围需要按代码划分。核对结果：手动 `/verify`（`verifySession`）和 idle 触发走的是同一条 `executeEntry` → `verifyAgent` 流水线，区别只在 `force`；`/eval` 直接调用 `verifyFive`，`eval/run.mjs` 依赖它。所以不能"整条 legacy 一起删"：

| 部分 | 代码 | L ≠ keep 时 |
|---|---|---|
| 自动触发 | `enabled`、`handleStatus` 中的 `scheduleAuto`、`skipStatusContinuation`（`turnGateDecision` 在 `force` 时跳过它） | 删除 |
| 发回 agent 的反馈 | `autoFeedback`、`maxFeedbackPerSession`、`host.ts` 的反馈分支 | 删除。L 臂衡量的正是这一反馈所依据的判定 |
| lane 执行 | `verifyFive`、`routes`、`timeoutMs`、`maxTokens`、`temperature`、`verifierSmallModel` | 保留，`/verify` 和 `/eval` 依赖 |
| 记录上的判定标签 | `scoreThreshold`、`disagreementThreshold`、`divergenceGuard*`、引用审计 | 保留，作为手动诊断记录的字段 |

L 臂的 `flagged` 因此定义为"在 `autoFeedback=true` 下会发回反馈"，即 `decideFeedback` 为真**且**引用审计找到独立缺陷证据，而不只是 `decideFeedback`。

冻结期间：只修 bug，不加功能。

## 9. 文档以代码为准的规则

| 事实 | 唯一来源 | 机制 |
|---|---|---|
| 默认值、取值范围、可选值 | `src/config.ts` schema | `scripts/doc-facts.mjs` 生成 README 的表；每个键必须有说明，缺说明时生成失败 |
| 运行限额 | `API_RATE_LIMITS`、`SELECTIONS_HISTORY_LIMIT`、`PREFLIGHT_OK_TTL_MS` | 同上 |
| 说明中的数值（如 workers auto=4） | 导出的常量 | 说明文字里写 `{AUTO_VERIFIER_WORKERS}` 占位，生成时代入 |
| 测试数 | CI 输出 | 权威文档禁止手写（`doc-truth` lint） |
| 当前行为 | README、ARCHITECTURE、API-BOUNDARY、PROTOCOL、VERIFIER-SCHEDULER、calibration README | `AUTHORITATIVE_DOCS` 清单，每份文档都要通过 lint |
| 某天发生过什么 | HANDOFF、`docs/*HISTORY*`、`docs/reviews/`、预注册 | 按日期记录，不 lint，不回改 |

工作流：改 `src/config.ts` 后运行 `node scripts/doc-facts.mjs --write`；`--check` 和 `npm test` 都会拦下过期的表。

lint 是关键词规则，只能抓本轮发现的四类漂移，抓不到"默认开启"这类不带 "default" 字样的散文。所以本轮还人工搜索了权威文档里关于开关状态的描述，没有发现残留。

## 10. 决策表

| 事项 | 本轮做法 | 需要负责人决定的 |
|---|---|---|
| 7.2 `selectionMode` 默认值 | 改为 `off`（已决定） | 无 |
| 7.3 legacy `enabled` 默认值 | 改为 `false`（已决定） | P1 之后是否按 §8 退役 |
| HANDOFF | 原地降级（已决定） | 无 |
| P1 执行 | 只做预注册和判定代码 | 是否批准构建 30 题和花费（上限 100 次 rollout、450 次调用） |
| auto 准入启发式 | 不改，画像已固定 | P1 结果为 continue 时，是否先压低提问和小改动的误收再推荐 |
| R1 1.9 默认 `baseURL` 是第三方中转 | 不改（生成表的说明里已标注） | 仍待决定 |
| R3 C3 margin 实测 | 不跑 | 是否与 P1 合并到同一次花费 |

## 11. 残余风险

- 准入语料由审查者标注，只有 40 条，代表性有限。测试固定的是"画像"，不是"正确率"；新增语料会改变画像，这是有意的设计。
- `doc-truth` 只覆盖关键词可识别的漂移（§9）。
- P1 的阈值（+10pp、3 倍成本、15 道分歧题）是判断，不是推导出来的；预注册禁止事后修改。
- live ledger 只来自作者一台机器的持久层配置（`selectionMode=always`、`effort=max`），不能代表出厂配置。

## 12. 兼容性影响

- 持久层里已显式保存过 `selectionMode` 或 `enabled` 的安装，行为不变。
- 依赖源码默认值的安装，升级后 autopilot 和 legacy idle 都会停止，直到在 GUI 或 settings 中打开。GUI 开关显示的是实际值。
- 手动 `/select`、`/verify`、`/eval` 不受影响。
- README 的「Current Defaults」由生成块替代；以前手写的状态段原样保存在 `docs/STATUS-HISTORY-2026-09.md`。

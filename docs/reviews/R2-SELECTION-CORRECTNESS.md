# R2 审查报告：选择判定链正确性

- 基线：`443102c`（R1 之后），审查分支 `arena/01a0d1de-dsh-verifier-autopilot`，PR #5
- 计划：`docs/REVIEW-PLAN-2026-09-24.md` §R2
- 回归测试：`scripts/tests/selection-correctness.test.mjs`（11 个测试；每条发现至少对应一条断言，检查类测试同时适配 sh 和 pwsh 两种方言）
- 门禁：`check:architecture`、`typecheck`、`build:host`、`build:client` 全绿；`npm test` **271/271**（R1 之后 260，新增 11；原有 260 条一条未改）；`bridge/self_test.py` 13 PASS / 1 SKIP；`git diff --check` 干净
- CI：新增 `scripts/tests/reporters/github-annotations.mjs`：失败的测试会以 `::error` 形式出现，测试自己输出的诊断会以 `::notice` 形式出现，都显示在 PR 的 check annotation 里。沙箱访问不到 Actions 日志的 blob 存储，第一次推送后 push 触发的 CI 失败了，原因看不到，所以补了这个 reporter。它第一次运行就给出了原因：`exit 3` 在 pwsh 下被误判为 harness error（`exit` 在 PowerShell 里是语言关键字，`Get-Command` 查不到），`1..400` 这类范围表达式被当成了程序名。两处都已在 `cbab106` 修复，并补了测试

## 1. 目标与方法

判定链是：**检查（shell）→ has-work 门 → 按 diff 指纹去重 → verifier 锦标赛 → margin 门 → outcome**。其中任何一环分类错误，都会**静默**改变结论：更好的候选被当成重复丢掉，真实失败被当成“环境问题”放过，没干活的候选被当成干过活。

本轮做法：
1. 先复现：两个 R2 已知 bug（2.1、2.2）在基线上用探测脚本复现，其余线索逐条对照代码确认。
2. 修复只动判定依据，不改 outcome 集合和 relay 契约（`objective_only_result` 保留为历史值，见 2.3）。
3. 同一个探测脚本分别跑基线构建和修复后构建，见 §4。

## 2. 发现与处置

| # | 严重度 | 发现 | 处置 | 位置 |
|---|---|---|---|---|
| 2.1 | **高** | **diff 指纹不含内容**：指纹只哈希 numstat（路径 + 增删行数）和未跟踪文件的 `名字:大小`。两个候选把 `x = 1` 分别改成 `x = 2` 和 `x = 9`，指纹都是 `84b7ab7f7b15343a`，被判为“无搜索空间”去重，另一个解直接被丢掉，verifier 根本看不到 | **已修复**。指纹改为对每个变更路径和未跟踪路径哈希 `路径 + NUL + 内容摘要`；内容摘要区分文件字节（sha256）、可执行位、符号链接目标（`readlink`，不跟随）和删除。行数统计仍来自 numstat。单次指纹最多哈希 256 MB 内容，超出部分退化为 `size:` 条目 | `live.ts gitDiffStat` |
| 2.1b | 中 | **空 diff 也会被去重**：几个候选都没改文件时（例如只给出答案），它们的指纹相同，被判为“同一个交付物”，只保留 c0 | **已修复**。`files == 0 && untracked == 0` 的候选不参与去重，它们的差别只在回答里，恰好是 verifier 要比较的东西 | `candidates.ts` 去重段 |
| 2.1c | 中 | **只有“全部相同”才去重，部分重复不去重**（审查中新发现）：3 个幸存者中 c0 和 c1 完全相同时，三者都进入锦标赛；内容相同的两个候选得分相同，排进前二后 margin 为 0，整轮 `abstain`，其实只有两个不同的解 | **已修复**。按指纹分组，每组保留编号最小的候选，其余标为 `eliminated`（`eliminatedBy: ['duplicate-diff:c<k>']`），编号写进新字段 `record.dedupedCandidates`，relay 附加 `Flag: deduped …`。只剩一组时走原有的 `noSearchSpace` 兜底；否则只把各组代表送进锦标赛 | `candidates.ts`、`autopilot.ts` |
| 2.2 | **高** | **harness-error 可被候选输出伪造**：真实失败时，只要输出尾部出现 `: not found`、`command not found`、`Syntax error` 等字样，就会被标成 `harnessError`，候选因此不被淘汰。候选删掉测试脚本（`./run-tests.sh: not found`）或自己的脚本打印同样文字，都能逃过淘汰 | **已修复**。harness-error 判定只依据**操作员控制的输入**（shell 和命令字符串），并在中立目录运行，不看候选控制的任何输出。见 §3 | `checks.ts runOne` |
| 2.3 | 低 | **`objective_only_result` 不可达**：catch 分支只在“所有幸存者都通过全部检查”时进入，此时通过数必然相等，“严格有序”的条件永远不成立。README 和 HANDOFF 都把它列为一种 outcome | **已删除死分支**。类型和 relay case 保留并注明“历史值”，旧 ledger 里的记录仍能读取和转发；README、HANDOFF 已改 | `candidates.ts` ranking catch |
| 2.4 | 中 | **只读工具被算作执行证据**：has-work 门只排除 meta 工具，一个只调用了 `read` 的候选，在代码任务里即使 diff 为空，也能凭一句“已修复”进入锦标赛 | **已修复**。新增只读白名单（`read`、`read_file`、`view`、`grep`、`glob`、`ls`、`list_dir`、`list_files`、`search_files`、`web_search`、`web_fetch`、`fetch_page`），不计入 `execToolCalls`。**未知工具名仍然计数**（保守：它可能会写）。仓库中能看到的 DSH 工具名只有 `read`/`write`/`edit`/`pwsh`（`eval/` 和测试夹具），`@deepseek-ai/dsh-agent` 包里没有工具目录，所以白名单无法从权威来源生成 | `trajectory.ts` |
| 2.5 | 中 | **cancel 之后没有硬上限**：候选超时后只调用 `agent.cancel?.()`，然后无限期等待 `whenIdle()`。cancel 不生效时，整个 selection 一直挂住，直到外部 abort | **已修复**。等待改为与 `candidateTimeoutMs + cancelGraceMs` 的计时器竞速（新增可选输入 `cancelGraceMs`，默认 30 s）。到点后候选记为 `failed`，`error: 'candidate-timeout (cancel not acknowledged within …ms)'`，并照常 dispose；计时器在 `finally` 中清理 | `candidates.ts` 驱动段 |
| 2.6 | 决策 | verifier 故障时，只有“所有幸存者都通过检查”才得到 `verifier_unavailable`，否则整轮 `failed`；没配检查时的故障直接失败 | **维持现状并写入文档**。依据裁决 K.5“基础设施故障不是裁决”：没有客观证据时，任何保留都等于凭空选一个；`failed` 的 relay 让源 agent 直接继续原任务，不误导。见决策表第 7、8 行 | 同上 |
| 2.7 | 低 | **轨迹只保留尾部**：超过 24k 字符时从头部截断，最先丢掉的就是候选自己的任务陈述 | **已修复（最小修复）**。头部截断时把第一条 `USER:` 行钉在最前面（最多占预算的 1/4，从预算中扣除，不额外占用），截断提示注明 “first task line kept above”。verifier 另外会收到完整的 `problem`，所以原先的影响主要是丢失了候选专属的指令；早期工具证据仍按尾部优先截断，转 R3 评估分布偏移 | `trajectory.ts renderTrajectory` |

## 3. 2.2 的设计：谁有资格说“这是环境的错”

原来的分类器用正则匹配**输出尾部**，而输出由候选写的代码控制，所以候选可以伪造这个判定。新的判定只接受不依赖候选的证据，按顺序：

1. **解析探测**：把命令包进一个永不执行的分支（sh 用 `if false; then … fi`，PowerShell 用 `if ($false) { … }`），在 `os.tmpdir()` 下、用剔除凭据后的环境运行。shell 必须先解析完整个脚本才能执行，所以非零退出只能说明命令本身解析失败。这种情况下返回 `harnessError`、`exitCode: null`，**命令从不在候选工作区运行**。探测和真实运行走同一条 argv 传递路径，所以 sel-5e84f540 那类 Windows PowerShell 引号被吞掉的问题同样能被抓到。结果按 `(shell, 命令)` 缓存；探测超时或无法启动的结果不缓存，退回真实运行（fail-open，等同旧行为）。
2. **真实运行**：`spawn-failed` 仍然是 harness error（与原来相同）。
3. **程序查找**：真实运行非零退出（超时和 abort 除外）时，取命令的首个程序名（`leadingCommandWord`：跳过 `VAR=` 赋值和 PowerShell 的 `&`，去掉引号；遇到路径、变量、表达式、shell 关键字时返回 null）。再在中立目录用 `command -v` / `Get-Command` 查找。**查不到**才判为 harness error，输出以 ``harness: `<程序>` does not resolve …`` 开头。
4. 其余一切非零退出都是候选的失败，会被淘汰。

为什么路径不参与第 3 步：`./run-tests.sh` 不存在，可能是候选删掉或改名导致的，这正是应当淘汰的情况。注入的测试 shell（没有这两个钩子）除 spawn 失败外永远不会产生 harness error，这一点与原有 `nodeShell` 测试一致。

## 4. 修复前后的行为证据

同一个探测脚本，分别跑基线 `443102c` 的构建和本轮构建（检查类用 `/bin/sh`；verifier 为按内容打分的假 bridge：c0 和 c1 是同一个解，得分相同）：

| 探测 | 基线 443102c | 修复后 |
|---|---|---|
| 检查输出 `helper: not found` 且 `exit 1` | **harnessError=true**（不淘汰） | false（淘汰） |
| 候选脚本打印 `sh: 1: node: not found` 且 `exit 127` | **harnessError=true** | false |
| 检查 `./run-tests.sh`，脚本已被删除 | **harnessError=true** | false |
| 检查 `definitely-not-installed-xyz` | harnessError=true | harnessError=true（查找探测确认） |
| 检查 `touch ran.txt; (`（语法错误） | harnessError=true，exit 2 | harnessError=true，exit null，工作区没有 ran.txt |
| `x = 2` 与 `x = 9` 的指纹 | **`84b7ab7f7b15343a` 两者相同** | `c8338531…` 与 `c66bcff8…` |
| 同名同大小、内容不同的未跟踪文件 | **碰撞** | 不同 |
| 两个空 diff 候选 | **single_candidate_fallback（noSearchSpace），verifier 看到 0 个** | verifier 看到 2 个 |
| 三个候选，c0 与 c1 相同 | **abstain，margin 0.000，verifier 看到 3 个** | ranked_winner，margin 0.500，verifier 看到 2 个，deduped=[1] |
| 只调用了 `read` 的候选声称“已修复”（代码任务） | **ranked_winner**，execToolCalls=1 | insufficient_evidence，execToolCalls=0 |
| 候选忽略 cancel（timeout 100 ms，grace 100 ms） | **5 s 后仍挂起** | 201 ms 结束，`candidate-timeout (cancel not acknowledged within 100ms)` |
| 截断后的轨迹里是否还有任务行 | **丢失** | 保留 |

## 5. 决策表

settled record 的完整分支，按代码执行顺序排列（`requiresWork = taskKind !== 'analysis-text'`；“幸存者”指 `status === 'finished'` 的候选）：

| # | 条件 | status | outcome | winnerBasis | 保留的槽位 | finalists | relay | 测试 |
|---|---|---|---|---|---|---|---|---|
| 1 | 驱动/检查阶段抛出非 abort 异常 | failed | — | — | 无 | — | loser notice | selection-runner 多处 |
| 2 | abort | aborted | — | — | 无 | — | loser notice | selection-runner（abort） |
| 3 | 检查真实失败（非 harness error） | —（候选 `eliminated`，`eliminatedBy` = 失败检查名） | 按剩余幸存者走下面各行 | | | | | correctness 2.2、selection-runner |
| 4 | 所有失败检查都是 harness error | 候选保留，`checksInvalid`，`objectiveEvidence='none'`，record 标 `checksUnreliable` | 按剩余幸存者走下面各行 | | | | 附 `Flag: checks-unreliable` | selection-runner B-10 |
| 5 | `requiresWork` 且候选既无执行类工具调用（排除 meta 和只读工具）也无非空 diff | —（候选 `eliminated: insufficient-evidence`） | 所有幸存者都被淘汰时为 `insufficient_evidence` | — | 无 | — | 禁止整合，直接完成原任务 | selection-runner F4、correctness 2.4 |
| 6 | 0 个幸存者（非第 5 行情况） | failed，`error='all_candidates_eliminated'` | — | — | 无 | — | loser notice | selection-runner |
| 7 | 1 个幸存者 | completed | single_candidate_fallback | 配了有效检查为 `objective-check-only`，否则 `single-candidate` | 该候选（`retained`/`fallback`） | 空 | SINGLE-SURVIVOR 契约，“从未与其他候选比较” | selection-runner |
| 8 | ≥2 个幸存者，按非空指纹去重后只剩 1 个 | completed，`noSearchSpace` | single_candidate_fallback | single-candidate | 最小编号的代表 | 空 | 同上，并注明“identical diffs deduped” | selection-runner F3 |
| 9 | ≥2 个幸存者，部分重复（去重后仍 ≥2） | 重复者 `eliminated: duplicate-diff:c<k>`，写入 `dedupedCandidates` | 代表们继续走第 10 到 13 行 | | | | 附 `Flag: deduped …` | correctness 2.1 |
| 10 | verifier 重试后仍失败，且不是所有幸存者都 `objectiveEvidence='pass'` | failed（异常重新抛出） | — | — | 无 | — | loser notice | selection-runner（K.5 反例） |
| 11 | verifier 重试后仍失败，所有幸存者都通过全部检查 | completed | verifier_unavailable | — | 无 | 空（没有 ranking） | “无比较，候选无序”，直接继续原任务 | selection-runner K.5 |
| 12 | verifier 返回，top-2 margin < 阈值（含完全平分） | completed | abstain | — | 无 | 前 2 名 | 同等强度证据，非偏好 | autopilot、selection-runner |
| 13 | verifier 返回，margin ≥ 阈值 | completed | ranked_winner | verifier | winner | 前 2 名 | FINALIZER CONTRACT | selection-runner |
| — | 历史值 `objective_only_result` | — | 不再产生 | objective-check-only | — | — | 保留 relay case 以兼容旧 ledger | — |

附加标记：没有任何幸存者带 `objectiveEvidence='pass'` 时写 `llmOnly`；analysis-text 任务跳过第 5 行和去重（没有 diff 可比）。

所有路径上的不变量：
- `winner` 只随 `ranked_winner` 出现，且 margin ≥ 阈值。
- 至多保留一个候选；其余全部 dispose。
- 不同内容的工作区永不共享指纹（在 256 MB 内容预算内）。
- harness error 永不淘汰候选；真实失败永远淘汰候选。

## 6. 残余风险

| 项 | 说明 | 建议 | 归属 |
|---|---|---|---|
| CI 在 pwsh 和 sh 之间不确定 | 同一个 SHA（`e90103d`）的 push 触发 CI 失败，pull_request 触发 CI 通过。失败的原因是 pwsh 专有的 bug（上面已修）；通过的那次说明当时解析出的检查 shell 不是 pwsh，最可能的原因是冷启动的 pwsh 超过了 15 s 的探测超时，于是退回 sh。也就是说 CI 每次跑的方言并不固定。现在 notice 会写出 `check shell under test: …` | R6：在 CI 里固定方言，或者 sh 和 pwsh 各跑一遍 | R6 |
| PowerShell 钩子只在 CI 上验证 | 沙箱里没有 pwsh，而且下载 pwsh 的出口被拦截。ubuntu-latest 预装 pwsh 7，本轮测试在 CI 上跑的就是 pwsh 方言（测试日志里有 `check shell under test: …` 这一行诊断）。**Windows PowerShell 5.1 没有 CI 覆盖** | R6 增加 Windows CI job | R6 |
| 检查多一次进程启动 | 每条不同的检查命令多跑一次解析探测（跨候选、跨 run 缓存）；失败的检查再多跑一次查找探测。pwsh 冷启动约 0.3 到 1 s | 可以接受；如需优化，可在 shell 解析时预热 | 书面接受 |
| 包装可被命令“逃逸” | 形如 `fi; rm x; if true; then` 的命令会在解析探测时于 tmpdir 下执行中间那段。命令来自操作员，而且本来就会在工作区执行，所以不构成信任边界问题 | 在 README 中注明检查命令必须是单一、自包含的命令 | 书面接受 |
| 被放弃的候选可能仍在运行 | 硬上限只保证 selection 不再等待，并调用 dispose；DSH 运行时如果连 dispose 都不响应，agent 进程可能还在写一个即将被删除的 worktree | 与“无进程组 kill”一起在 R4 处理 | R4 |
| 只读白名单靠命名 | 新增的只读工具在加入白名单之前仍会被计为执行证据（保守方向）；`pwsh Get-Content` 这类通过 shell 的只读操作同样计为执行 | 等 DSH 提供工具元数据（readOnly 标记）后替换白名单 | DSH |
| 截断仍会丢早期证据 | 只钉住了任务行 | R3 评估 24k 截断与校准数据的分布偏移 | R3 |
| 超预算文件退化为按大小比较 | 超过 256 MB 的内容预算后，两个同大小的大文件可能碰撞 | 只影响生成超大产物的候选；需要时可以提高预算或改为流式 git hash-object | 书面接受 |

## 7. 兼容性影响

- **更多真实失败会被淘汰**：过去因输出里偶然含 `not found`（例如测试里断言“文件不存在”）而被放过的候选，现在会被淘汰。这是修复本身的目的。
- **去重更少也更准**：空 diff 候选和内容不同的候选会进入 verifier，因此 verifier 调用可能比以前多；部分重复会被去重，调用也可能减少。
- **`insufficient_evidence` 会更常出现**：只读取、不改动的代码任务候选会进入这个 outcome。
- **record 新增字段**（可选，不影响旧读者）：`dedupedCandidates`；`SelectionRunInput.cancelGraceMs`。候选的 `eliminatedBy` 新增取值 `duplicate-diff:c<k>`（仓库中没有其他代码读取这个字段）。
- **不再产生 `objective_only_result`**：读取 ledger 的消费者不受影响，类型和 relay 都保留。
- **指纹值全部改变**：旧 record 里的 `diffStat.fingerprint` 不能和新值比较。没有任何代码跨 run 比较指纹。

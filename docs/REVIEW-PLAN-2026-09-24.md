# 全仓审查计划（2026-09-24，基线 6fb4462）

> 这是一份审查计划，不是审查结论。表中“线索”都是本次通读代码时已经定位到的具体问题。
> 标 ✅ 的已用最小复现确认；其余要在对应轮次里用测试证实或证伪。
> 每一轮的产出都是“发现 → 失败测试/复现 → 修复或书面接受”，不接受只停在口头描述。

## 进度

所有轮次都在同一个 PR 上迭代。每轮的报告放在 `docs/reviews/`。

| 轮 | 状态 | 报告 | 回归测试 |
|---|---|---|---|
| R1 信任边界与执行安全 | ✅ 已完成（1.1 沙箱和 1.9 默认中转待负责人决策） | `docs/reviews/R1-TRUST-BOUNDARY.md` | `scripts/tests/trust-boundary.test.mjs` |
| R2 选择判定链正确性 | ⏳ 待开始 | | |
| R3 证据与度量有效性 | ⏳ | | |
| R4 并发、生命周期与资源回收 | ⏳ | | |
| R5 持久化、审计包、脱敏与协议 | ⏳ | | |
| R6 架构与构建/发布链 | ⏳ | | |
| R7 文档真实性与产品方向 | ⏳ | | |
| R8 复核收口 | ⏳ | | |

## 0. 基线（审查开始前已实测）

| 门禁 | 结果 |
|---|---|
| `npm ci --force --ignore-scripts` | OK |
| `check:architecture` / `typecheck` / `build:host` / `build:client` | 全绿 |
| `npm test` | **253/253 pass**（README 写 203，HANDOFF 写 191：文档已漂移） |
| `bridge/self_test.py` | 13 PASS / 1 SKIP（本机没装 `llm_verifier`，mojibake 门跳过） |
| 本机限制 | 没有 `pwsh`（检查命令走 `/bin/sh` 回退），没有 `llm_verifier`。所有要调 provider 的路径都没有真实执行过 |

## 1. 对整体架构的理解（审查依据）

```
源会话 pre-step(step=1)
  ├─ 旧路径（legacy）: idle → 协调器 → verifyFive（5 条 lane，TS 自带打分器）→ 可选反馈 followup
  └─ autopilot（默认 auto）: 准入正则 → 解析仓库 → 模型目录/探活 → SelectionHost.start（后台，不阻塞源 turn）
        → N 个 git worktree（快照源工作区）→ N 个 danger-full-access 子 agent 并行
        → 检查（shell）→ has-work 门 → 按 diff 指纹去重 → Python sidecar（llm_verifier 锦标赛）
        → margin 门 → outcome 状态机 → 审计包 → relay（followup 注入源会话）
        → 源会话 idle → 交付审计（HEAD/dirty + 可选测试命令）→ 丢弃 winner
HTTP 控制面: /state /config /select /selections/* /verify /probe /eval /events（token 可选）
```

架构上几个关键事实决定了审查方向：

1. **这是一个“让 LLM 在用户机器上无人值守执行代码”的系统。** 候选全权限运行，检查命令是任意 shell，交付审计还会在用户仓库里跑命令。所以**安全边界是头号风险**，排在“排序准不准”之前。
2. **系统的价值主张是“选出更好的候选”。** 但它的判定链（检查 → has-work → 去重 → margin → outcome）每一环都在丢信息或做分类，任何一环分类错了都会**静默**改变结论。
3. **证据的真实性是项目自己的最高原则**（README 和 HANDOFF 反复强调“实现存在 ≠ 运行成功 ≠ 质量提升”），所以要按这个标准审计校准方法和交付审计本身。
4. **并发很重**：autopilot 在后台跑，和源 turn 同时进行；还有 relay/idle 清理，以及 sidecar 串行管道被多方共享。
5. 模块边界已经做过一轮整理（`check:architecture`），但 `selection/host.ts`（1060 行）、`candidates.ts`（1003 行，`run()` 大约 500 行）和 `host.ts`（815 行）仍然是三个超大模块。

## 2. 轮次总览（按风险 × 依赖排序）

| 轮 | 主题 | 为什么排在这里 | 主要文件 |
|---|---|---|---|
| R1 | 信任边界与执行安全 | 影响用户机器和凭据，风险最高；后续修复可能改动接口 | `selection/live.ts` `selection/host.ts` `selection/checks.ts` `api.ts` `config.ts` `util.ts` |
| R2 | 选择判定链正确性 | 系统核心价值；已有 ✅ 真 bug | `selection/candidates.ts` `checks.ts` `live.ts(gitDiffStat)` `trajectory.ts` |
| R3 | 证据与度量有效性（校准、交付审计） | 决定“结论能不能信”；依赖 R2 的判定链先正确 | `eval/calibration/*` `docs/MARGIN-GRADUATION-INVOICE.md` `host.ts(审计)` `bridge/*.py` |
| R4 | 并发、生命周期与资源回收 | 竞态类问题要在判定链稳定后才好写确定性测试 | `host.ts` `selection/host.ts` `bridge.ts` `proc.ts` `live.ts` |
| R5 | 持久化、审计包、脱敏与协议契约 | 证据保存和对外出口 | `ledger.ts` `selection/host.ts(artifact)` `bridge/PROTOCOL.md` `protocol.ts` `client/` |
| R6 | 架构可维护性与构建/发布链 | 重构应在语义问题修完之后做，避免重构掩盖 bug | 全 `src/`、`scripts/build.sh` `tsdown.config.ts` CI |
| R7 | 文档真实性与产品方向（ROI） | 需要前六轮结论作为输入 | README/HANDOFF/ARCHITECTURE/API-BOUNDARY、`config.ts` 默认值 |
| R8 | 复核收口 | 回归全部门禁，逐条关闭或书面接受 | 全仓 |

---

## R1 信任边界与执行安全

**目标：** 画出威胁模型。每个“不可信输入 → 高权限动作”的通道，要么有控制，要么有书面接受理由。

已定位线索：

| # | 线索 | 位置 |
|---|---|---|
| 1.1 | autopilot 强制 `danger-full-access` 加 approval=never。worktree 只隔离 cwd，并不限制文件系统和网络。唯一的防线是 `EXTERNAL_SIDE_EFFECT` 关键词黑名单和提示词（`git push`、`curl`、`rm -rf`、`npm i` 这些都不在名单里） | `selection/host.ts:598`、`live.ts:272`、`autopilot.ts:47` |
| 1.2 | 检查命令和交付审计的 `runProcess` 继承完整 `process.env`，候选自己写的代码（例如被 `npm test` 执行的测试文件）能读到 `KIMI_API_KEY` 等宿主凭据 | `proc.ts`（没有传 env）、`checks.ts:runOne` |
| 1.3 | HTTP token 是可选的，而且 **GUI 从不发送 Authorization 头**。一旦设置 `DSH_VA_API_TOKEN`，面板的所有写操作都会 403，所以 token 在实践中等于不可用 | `api.ts:162`、`client/index.ts` 的 fetch 调用 |
| 1.4 | 未鉴权的 `POST /config` 可以把 `apiKeyEnv` 改成任意环境变量名（如 `GITHUB_TOKEN`），再把 `baseURL` 改成任意主机；随后 `/probe` 或自动探活会把这个变量的值当 Bearer 发出去，即**凭据外泄** | `config.ts validateConfigPatch`、`util.ts resolveKey`（回退到 `process.env[ref]`）、`api.ts` 的 probe |
| 1.5 | `POST /config` 可以设置 `selectionPostAuditTestCommand`，下一次源 idle 时会在**用户仓库**里执行，等于配置即命令执行。代码注释说 “this hook intentionally never runs on the user's repository”，与实现相反 | `host.ts:438-444` |
| 1.6 | `/verify` 和 `/probe` 不校验 content-type，`text/plain` 简单请求可以跨站触发（CSRF，产生 provider 花费和反馈注入）；`/config`、`/select`、`/eval` 有校验，标准不一致 | `api.ts:180,247` |
| 1.7 | `/select` 接受任意 `sourceCwd`；`groundTruthNote`、`agentPreset`、`algorithmSeed` 未校验，`criteria` 的条目数和长度无上限，会原样进入 sidecar 和提示词 | `selection/host.ts start()`、`safeCriteria` |
| 1.8 | 提示注入：候选轨迹直接拼在 `[DETERMINISTIC EVIDENCE]` 前言后面，候选可以伪造同样的块来骗 verifier；relay 里的 `finalist.handoff` 可以伪造 `[END CANDIDATE cN]` 和 `[FINALIZER CONTRACT]` 来控制源 agent | `candidates.ts deterministicPreface`、`autopilot.ts buildAutopilotRelay` |
| 1.9 | 默认 `baseURL` 是第三方免费中转 `chat.holisthoom.top`，开箱即把源代码轨迹和 key 发给第三方 | `config.ts:106` |

方法：
- 列一张威胁模型表：入口（HTTP、候选输出、源任务文本、配置），资产（凭据、用户仓库、宿主进程、provider 额度），当前控制，残余风险。
- 每条先写**攻击测试**（期望失败）。例如 1.4：打一个 config 补丁，把 probe 指向本地假服务器，断言收到的 Bearer 头。
- 按“修复”或“书面接受”分流。能书面接受的只有 API-BOUNDARY 里已经明确 parked 的项，并在文档里补上残余风险。

验收：威胁模型表落在文档里；1.2、1.4、1.5、1.6、1.8 有回归测试；1.1 有明确决策（沙箱/网络策略，或把默认模式降级，见 R7）。

## R2 选择判定链正确性

**目标：** 任意候选组合都要得到正确、可解释的 outcome；不允许静默丢弃更好的候选，也不允许淘汰失效。

已定位线索：

| # | 线索 | 位置 |
|---|---|---|
| 2.1 ✅ | **diff 指纹碰撞**：指纹只哈希 numstat（路径 + 行数）和未跟踪文件的“名字:大小”，不包含内容。两个候选把 `x = 1` 分别改成 `x = 2` 和 `x = 9`，指纹完全相同，结果被判为 no-search-space 去重，更好的那个可能被直接丢掉 | `live.ts:573`（已复现：两个 worktree 都是 `84b7ab7f7b15343a`） |
| 2.2 ✅ | **harness-error 分类可被候选输出伪造或误触发**：真实测试失败时，只要输出里出现 `": not found"`、`command not found`、`syntax error` 这类字样，就会被标成 harnessError，候选因此不被淘汰。候选删掉测试脚本导致的 `not found` 同样能逃过淘汰 | `checks.ts:60-68`（已复现：`AssertionError…; helper: not found; exit 1` 得到 `harnessError=true`） |
| 2.3 | `objective_only_result` **不可达**：只有当所有幸存者都 `objectiveEvidence==='pass'`（全部检查通过）时才会进这个分支，此时各候选的通过数必然相等，“严格有序”的条件永远不成立。README 把它列为一种 outcome，测试里一次都没出现过 | `candidates.ts:883` |
| 2.4 | has-work 门把任何非 meta 工具调用都算作执行证据，只读的 `read`/`grep` 也算，`insufficient_evidence` 几乎不会触发 | `trajectory.ts META_TOOLS`、`candidates.ts` has-work 段 |
| 2.5 | 候选超时只调用 `agent.cancel?.()`，随后 `whenIdle()` 没有硬上限；如果 cancel 没生效，run 会一直挂住，直到被外部 abort | `candidates.ts:575` 附近 |
| 2.6 | verifier 故障时只有“全部幸存者都通过检查”才走 `verifier_unavailable`，否则整轮 `failed`；没配检查时的 verifier 故障直接失败，这是否符合裁决 K.5 需要确认 | `candidates.ts` ranking 的 catch 段 |
| 2.7 | 轨迹截断只保留尾部 24k，任务陈述和早期关键证据会被丢掉；verifier 看不到被截掉的部分，但仍然被要求判断“完整性” | `trajectory.ts renderTrajectory` |

方法：
- 画出 outcome × winnerBasis × retained slot × relay 分支的**完整决策表**，逐格对照代码和测试。
- 用假 bridge 对 `SelectionRunner` 做表驱动或性质测试：随机生成候选状态、检查结果、diff、分数，断言不变量（例如 winner 必须 margin ≥ 阈值；不同内容不能被判为同指纹；真实失败必须淘汰）。
- 2.1 和 2.2 先写失败测试再修（内容哈希用 `git diff HEAD` 加未跟踪文件内容；harness 判定改为结构化判断，例如 shell 退出码 127/解析阶段，而不是全文正则）。

验收：决策表入文档；2.1、2.2 修复并有回归测试；2.3 要么删掉，要么改成真正可达的语义。

## R3 证据与度量有效性

**目标：** 按项目自己“只信已证实事实”的标准，审计校准方法和交付审计是否真的支撑现有结论。

| # | 线索 | 位置 |
|---|---|---|
| 3.1 | **margin 阈值和当前 verifier 不匹配**：0.03 是在 minimax-m3 / kimi-k3 @low 下校准的，而默认 verifier 已换成 `nvidia/nemotron-3-super-120b-a12b`。记录里有 `marginCondition`，但阈值并不按条件取值，relay 仍然写 “cleared the margin gate” | `config.ts`、`candidates.ts` margin 段、`MARGIN-GRADUATION-INVOICE.md` |
| 3.2 | C0 用“同一候选自比”测噪声，会低估“两个不同但质量相当的候选”之间的噪声；校准用的是几百字符的合成轨迹，生产输入是 24k 截断轨迹加确定性前言，存在分布偏移 | `eval/calibration/run.mjs` |
| 3.3 | **交付审计被混淆**：autopilot 和源 turn 并发执行，源 agent 自己的改动也会让 HEAD 变化或工作区变脏，并被算作“集成证据”，`delivered` 因此无法归因到 relay | `host.ts` 的 cleanupAutopilotWinnersOnce、`sourceHeadAtStart`（`selection/host.ts:639`） |
| 3.4 | 调度恒等式 `usage.calls == expectedVerifierCalls` 只记录，不校验也不告警 | `candidates.ts`、`docs/VERIFIER-SCHEDULER.md` |
| 3.5 | 两套打分实现：legacy 的 TS `distributionAt/scoreFrom`，和 Python `llm_verifier` 加猴补丁 `_find_tag_logprobs`。两边对标签的容错语义不同，一侧的校准结论不能直接搬到另一侧 | `verifier.ts`、`llm_verifier_sidecar.py` |
| 3.6 | `eval/run.mjs` 和校准脚本写死了 `127.0.0.1:3080`、`C:/Users/Admin/...`，离开作者机器无法复现 | `eval/*` |

方法：离线复算已有校准数据的统计量（graduate.mjs 的逻辑），推导“按条件取阈值”的数据结构；把交付审计改成对比 relay 前后的快照（relayedAt 时刻采样 HEAD），并审查 `evaluateDelivery` 的语义。

验收：写一份“哪些结论目前有证据、哪些没有”的对照表；3.1 决定是按条件查阈值，还是在条件不匹配时强制 abstain 或打标；3.3 的归因方案落地。

## R4 并发、生命周期与资源回收

| # | 线索 | 位置 |
|---|---|---|
| 4.1 | relay 与 idle 清理之间有竞态：清理由**任意** idle 触发，并不关联“消费过 relay 的那个 turn”。如果源在原始 turn 还没结束时 relay 就已排队，原 turn 结束的那次 idle 可能先把 winner 工作区删掉。现有测试只覆盖“relay 之后 idle 一次”的理想顺序 | `host.ts handleStatus`、`scripts/tests/autopilot.test.mjs:244` |
| 4.2 | 源工作区快照（先 `git diff` 再逐个 `cp`）是在源 agent 并发写文件时进行的，不是原子快照 | `live.ts mirrorGitWorkingState` |
| 4.3 | 同一时间只允许一个 selection，而 autopilot 每个可执行 turn 都会触发；busy 时只写一条诊断，用户不可见 | `selection/host.ts`、`host.ts` 准入 catch |
| 4.4 | 进程树回收不完整：`runProcess` 只 kill 直接子进程，没有用进程组（`detached` 加 `process.kill(-pid)`），POSIX 下超时检查的孙进程会泄漏。现有文档只承认了 Windows 上的这个问题 | `proc.ts` |
| 4.5 | preflight 成功按 `baseURL|model|apiKeyEnv|effort` 缓存，key **值**轮换后不会重新验证；探活的 ok 结果在整个进程生命周期内永久有效 | `selection/host.ts runVerifierPreflight`、`probe.ts` |
| 4.6 | sidecar 串行管道由 progress 采样和 select 共享；任何一次超时或 abort 都会 teardown 整个子进程，排队中的其他请求一起失败 | `bridge.ts request()` |
| 4.7 | `execCapture` 是 `runProcess` 之外的第二套 spawn 实现（没有 kill 升级，没有 flush 宽限） | `live.ts` |

方法：用 deferred 或假时钟写确定性竞态测试（4.1 模拟“relay 在源 running 时入队”），做故障注入（kill、超时、磁盘满），并在 Linux 上实测孙进程泄漏（`sleep` 子进程）。

验收：4.1、4.4 有回归测试并修复；其余给出决策。

## R5 持久化、审计包、脱敏与协议契约

| # | 线索 | 位置 |
|---|---|---|
| 5.1 | **出口脱敏不对称**：legacy 路径对发出去的提示做了 `redactSecrets`；选择路径发给 sidecar 的候选轨迹、写入磁盘的 `traces/*.txt` 和 `diffs/*.patch`、relay 文本全部没有脱敏。候选只要执行过 `env`，key 就会进入 verifier 请求、审计包和源会话 | `selection/host.ts:925-937`、`candidates.ts` select 调用、`util.ts` |
| 5.2 | 同一个 selectionId 会写多行（running、终态、relay、丢弃），以最后一行为准；丢弃时直接原地修改记录，与注释里“settlement attribution stays immutable”的说法矛盾 | `selection/host.ts persist/pubRecord/discardWinnerNow` |
| 5.3 | ledger 追加没有 fsync，掉电语义没有写清；超过 4MiB 时 `persist()` 走压缩分支，需要确认当前记录一定被包含在内 | `ledger.ts`、`selection/host.ts persist` |
| 5.4 | sidecar 协议没有版本协商（health 不带 protocol 版本）；`"logprob" in str(exc)` 这种子串映射很脆弱；`n_evaluations ?? 4` 这个兜底和 Host 默认值（1）不一致 | `bridge.ts select`、`llm_verifier_sidecar.py _map_exception` |
| 5.5 | `/state` 和 SSE 会把 `configSnapshot.sourceCwd` 等本机绝对路径、完整配置广播给任何本地读取方 | `protocol.ts`、`api.ts /state` |

方法：枚举所有出口（网络、磁盘、源会话、`/state`），每个出口核对是否脱敏；对 ledger loader 做模糊测试（截断行、重复 id、未来版本）；逐字段对照协议 fixture。

验收：出口清单和脱敏矩阵；5.1 修复并有测试。

## R6 架构可维护性与构建/发布链

| # | 线索 | 位置 |
|---|---|---|
| 6.1 | 三个超大模块。`VerifierHost` 同时承担 legacy 调度、autopilot 准入/relay/交付审计、探活，违背它自己的“Selection 不依赖 legacy”精神；建议抽出 `AutopilotController` | `host.ts`、`selection/host.ts`、`candidates.ts run()` |
| 6.2 | **发布构建和 CI 构建不一致**：`scripts/build.sh`（esbuild、写死 Windows `D:/` 路径、外部依赖只排除 react）和 CI 用的 `tsdown`（还外置 cordis/ui-slots）产出的 client 包不同，CI 测的不是实际发布的产物 | `scripts/build.sh`、`tsdown.config.ts` |
| 6.3 | 默认值和常量漂移：Host 的 `DEFAULT_SELECTION_TIMEOUT_MS=180000` 对比配置的 600000；注释里的“300s floor”对比实际兜底 600000；sidecar 注释说默认 effort 是 max，配置实际是 low；`OPERATOR_BRIDGE_VENV_PYTHON` 写死了 `D:/` 路径 | `selection/host.ts:161,198`、sidecar |
| 6.4 | 架构检查只禁止 `as never` 和 `as unknown as`，对不可信输入仍有大量 `as X` 断言（`safeChecks`、`safeCriteria`、`isRecordState`） | `scripts/check-architecture.mjs` |
| 6.5 | 测试盲区：`makeLiveCandidateFactory`、`makeChildSetup`（沙箱/approval/模型注入）、交付审计的测试命令路径、`danger-full-access` 分支都没有离线测试；没有覆盖率统计；CI 只跑 Ubuntu + Node 22，而生产环境是 Windows（路径、pwsh、junction） | `scripts/tests/`、`.github/workflows/ci.yml` |
| 6.6 | peerDependencies 里声明了 `@deepseek-ai/dsh-agent`，源码里没有引用 | `package.json` |

方法：统计依赖图和模块规模；跑 `node --test --experimental-test-coverage` 出覆盖率热力图；比较两种构建产物的 diff；设计 Windows CI 矩阵。

验收：拆分方案，只出设计、不在本轮大改；构建路径统一方案；覆盖率报告和补测清单。

## R7 文档真实性与产品方向（ROI）

| # | 线索 |
|---|---|
| 7.1 | 测试数（191/203/253）、默认阈值（校准 README 仍写 0.08）、默认 effort 等多处文档和代码不一致；HANDOFF 里混着大量作者机器专用路径和运维流水，不适合作为仓库权威文档 |
| 7.2 | **默认开启的成本和价值不对称**：`selectionMode=auto` 让每个“可执行”用户 turn 额外跑 2 个全权限 rollout，外加探活和 verifier；legacy `enabled=true` 让每个 idle turn 调 5 条 lane。项目自己的文档承认 P0/P1（固定题集、pass@1 对比 pass@N、verifier top-1 与 oracle 一致率）都还没做，质量提升“尚未证明” |
| 7.3 | legacy 五 lane 路径和 BoN 路径两条线并行维护，legacy 的去留要有数据支撑 |

产出：一份决策备忘录，建议包括：
- 在 P1 基线出来之前，autopilot 默认改为 `off` 或需要显式 opt-in；
- 定义一个固定小题集作为继续投入的判据；
- 给出 legacy 路径的保留或退役建议；
- 文档改为以代码生成的数字为准，例如测试数由 CI 输出，不手写。

## R8 复核收口

- 重跑全部门禁（加上 R6 可能新增的覆盖率和 Windows 任务）。
- 每条线索只有三种状态：已修复（附测试名）、书面接受（附理由和残余风险）、转为待办（附验收标准）。
- 更新 README、ARCHITECTURE、API-BOUNDARY 里受影响的章节。

## 3. 贯穿所有轮次的规则

1. 先复现，再下结论：每条发现至少附一个最小复现或失败测试。
2. 修复的 PR 按轮次拆分，一轮一个主题，便于回滚和评审。
3. 不跑 live selection、不花 provider 额度（和 HANDOFF §8 一致）；需要 live 证据的项标为“待 live 验证”。
4. 改默认值（R1.1、R7.2）属于产品决策，要先和负责人确认，不在审查里单方面改。

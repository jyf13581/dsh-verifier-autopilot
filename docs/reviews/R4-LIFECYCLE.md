# R4 审查报告：并发、生命周期与资源回收

- 基线：`d28f656`（R3 之后），审查分支 `arena/01a0d1de-dsh-verifier-autopilot`，PR #5
- 计划：`docs/REVIEW-PLAN-2026-09-24.md` §R4
- 提交：`0a5a1da`（4.1/4.4/4.7/4.7b）、`31e9aee`（4.2）、`4feed3a`（4.3/4.5）、`e256ce1`（4.6），以及本报告与文档同步
- 回归测试：`scripts/tests/lifecycle.test.mjs`，14 个测试。用于替身的 fake 只模拟 DSH 类型声明里写明的契约（`agent.status` 镜像、inbox 投影）；进程类测试跑的是真实子进程，用 `ps` 精确匹配 argv 计数，中间不经过 shell
- 门禁：`check:architecture`、`typecheck`、`build:host`、`build:client` 全绿；`npm test` **303/303**（R3 之后 289，新增 14；原有测试一条未改）；`bridge/self_test.py` 13 PASS / 1 SKIP；`git diff --check` 干净；四个提交的 push 和 pull_request 两路 CI 全绿，check shell 均为 pwsh
- 约束：本轮没有产生任何 provider 调用

## 1. 目标与方法

R4 审查的对象是插件**与时间有关**的行为：后台 selection 与源 turn 并发执行，relay 与 idle 清理交错发生，子进程会超时或被中止，缓存会过期。做法：

1. **先读宿主契约，再判断竞态是否真实存在。** `node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts` 写明了 `followup`、`agent/status`、`Agent.status`、`Agent.inbox` 的语义。计划里 4.1 描述的那个时序，在这份契约下**不可能**出现；但同一处代码另有两条真实路径会出问题（§3）。
2. **在 Linux 上实测。** 孙进程泄漏（4.4）和 EPIPE 致宿主崩溃（4.7b）都先用最小脚本复现，再落成测试。
3. **确定性测试。** 4.1 由测试按步骤推进 `status` 和 inbox；4.2 通过构造参数里的测试钩子，把源仓库的修改精确注入到快照中途；4.5 使用假时钟；4.6 用一个只会在被中止时返回的 progress。没有依赖 sleep 时序的断言。
4. **同一份测试文件跑基线。** 在 `d28f656` 的 worktree 构建上运行（§6）。

## 2. 发现与处置

| # | 严重度 | 发现 | 处置 | 位置 |
|---|---|---|---|---|
| 4.7b | **高**（新） | `execCapture` 往子进程 stdin 写数据，但 stdin 流上**没有 `error` 监听**。子进程不读 stdin 就退出时（例如 `git -C <候选目录> apply -`：候选目录在 prepare 期间被并发的 cancel/dispose 删掉，git 立即以 128 退出，而补丁大于 64 KiB 的管道缓冲），写入失败产生 EPIPE，这个未处理的 `error` 事件会**直接结束整个 Node 进程，也就是 DSH 宿主**。最小复现：`spawn('sh',['-c','sleep 0.2; exit 1'])` 并写入 4 MiB，进程 exit 1，报 `Unhandled 'error' event … EPIPE` | 统一 spawn 核心：stdin 一律写完后 EOF，EPIPE 被吞掉，失败由子进程自己的退出码表达 | `proc.ts spawnBounded` |
| 4.1 | 高 | **winner 清理与 relay 的消费脱钩。** 计划描述的时序（原 turn 结束的 idle 抢在 relay turn 之前）在 DSH 契约下不会发生：`running` 一直持续到 driver 排空所有排队的 turn，`idle` 的含义是没有任何 driver 已排期或正在运行。但清理判据仍然只是“某个 idle 曾经发生过”，有两条真实路径：(a) **合并后的重跑**——某次 idle 触发的清理还在进行时，又来一次 idle，设置了 `rerun`；重跑会重新读取 `pending`，把此后才 relay 的 selection 也算进去，在 relay turn 读取 winner 的同时把它审计并删除；(b) **cancel 收敛**——契约写明，cancel 之后提交的 followup 要等被中止的活动收敛到 idle 后才运行，所以这个 idle 早于 relay turn | 在**执行清理的时刻**判断：源 agent 当前不在 `running`，且该 selection 的 relay 消息（按 DSH message id 匹配）已不在 `inbox.nextTurn/nextStep` 中（已被消费，或被 cancel 丢弃，两者都是终态）。源已不存在时（disposed、宿主 dispose）无条件清理。每次推迟都计数 `autopilot.cleanup_deferred` | `host.ts relayStillOutstanding` |
| 4.4 | 高 | `runProcess` 只 kill 直接子进程。实测：`sh -c "sleep N; echo"` 超时后 `sleep` 仍然存活；check 正常退出后，它用 `&` 启动的后台进程也会一直存活。现有文档只承认了 Windows 上的问题 | POSIX 下以 `detached` 方式启动（setsid），子进程成为进程组组长；timeout/abort 对整个进程组发 SIGTERM，结束时再补一次 SIGKILL。check 命令另开启 `reapGroup`：命令正常退出后，回收进程组里剩下的进程。Windows：在 shell 还活着时尽力执行 `taskkill /T /F` | `proc.ts signalTree`、`checks.ts` |
| 4.2 | 高 | 比计划描述的更严重：不只是“快照不原子”。每个候选都**分别**从活的源仓库执行 `worktree add HEAD` 加镜像，而 autopilot 不会暂停源 turn。源 agent 在两次 prepare 之间改了文件或提交了 commit，候选就会从**不同的字节、甚至不同的 HEAD** 出发，verifier 比较的是起点不同的候选 | 只有第一个准备成功的候选（seed）读取源仓库：worktree 固定在镜像前指纹里读到的那个 commit；镜像前后各取一次指纹（HEAD 加所有脏文件的内容摘要），不一致就重做，最多 3 次。其余候选从 seed 复制；在所有工作区准备完毕之前，没有任何 agent 会碰 seed。记录写入 `workspaceSeed {seedIndex, head, attempts, consistent}`；`consistent:false` 时额外报 `workspace.seed_torn` | `live.ts prepare`、`candidates.ts` |
| 4.6 | 中 | progress 采样与 select 共用 sidecar 的串行管道，任何一次超时或 abort 都会 teardown 整个子进程。采样队列 `progressChain` **从未被 await**，所以 select 可能排在一个慢的采样后面，随它一起失败。progressGuard 只能通过显式的 `/select` 开启（autopilot 不会开），因此只影响手动 selection | 采样使用独立的 signal（与 run 的 signal 联动）。所有候选结束后，runner 中止正在进行的采样并 await 队列，然后才进入 checks 和 ranking。这次主动中止不记为 `progress.sample` 降级 | `candidates.ts` |
| 4.5 | 中 | preflight 的 memo 键是 `baseURL\|model\|apiKeyEnv\|effort`，用的是 **env 变量名**而不是 key 的值，而且永不过期：key 轮换或吊销后、中转不再返回 logprobs 后，都仍被视为“已验证”，直到重载。探活的 ok 结论同样永久有效 | memo 键加入 key 值的 SHA-256 前 16 位（只保存在内存里，不落盘、不进日志），验证结果有效期 `PREFLIGHT_OK_TTL_MS` = 30 分钟；探活 ok 也只在 `okTtlMs`（30 分钟）内有效，过期后重新探测，**不会**被误报成 dead（修复了实现过程中自己引入的一个边界错误：过期的 ok 落入 dead 冷却分支） | `selection/host.ts`、`probe.ts` |
| 4.3 | 低 | autopilot busy 时，只留下一条通用的 `autopilot.admission` 警告，和真正的准入故障无法区分 | `/state` 新增 `autopilotSkipped {count, recent[20]}`，记录源会话和当时的占用者；计数器 `autopilot.skipped_busy`；面板显示“自动候选已跳过 N 次”。不做排队，不往会话里发通知（§7） | `host.ts`、`protocol.ts`、`client/index.ts` |
| 4.7 | 低 | `execCapture` 是 `runProcess` 之外的第二套 spawn 实现：没有 SIGKILL 升级（子进程忽略 SIGTERM 时 promise 永远不 settle，`prepare()` 随之挂死），没有 flush 宽限，也没有 EPIPE 防护 | 合并到 `proc.ts` 的同一个核心（`runProcessCapture`：字节精确输出，超限即停止子进程）；`runProcess` 的 stdin 也改为立即 EOF（读 stdin 的命令不再一直阻塞到超时）。加了守卫测试：`src/` 下只有 `proc.ts` 和长驻的 sidecar bridge 可以 import `child_process` | `proc.ts`、`live.ts` |

## 3. 4.1 的设计：谁有资格说“relay 已经读完了”

依据都来自 DSH 的类型契约：

- `followup()` 是同步的：消息立刻进入 inbox；空闲状态下会同步切换到 `running`。
- `status` 会镜像每一次 `agent/status` 转换；`idle` 的含义是没有任何 driver 已排期或正在运行。
- `inbox.nextTurn/nextStep` 是待处理输入的投影；消息被某个 turn claim 之后就离开 inbox。
- `cancel()` 默认清空 inbox。

因此，一个保留中的 winner 可以被审计和删除，当且仅当**在执行清理的那一刻**：

| 源 agent | relay 在 inbox 中 | 结论 |
|---|---|---|
| 已不存在（disposed / 宿主 dispose） | — | 清理（不会再有人读这条 relay） |
| `running` | — | 推迟（可能正是 relay turn；下一次 idle 再试） |
| 非 running | 仍在排队 | 推迟（cancel 收敛的 idle；relay turn 还没开始） |
| 非 running | 不在 | 清理（relay 已被消费，或被 cancel 丢弃，都是终态） |

- **兼容旧宿主：** 没有 `status`/`inbox` 字段的宿主（以及旧的测试替身）保持原来“idle 即清理”的行为。
- **时序保险：** 契约没有写明 `status` 镜像是在 emit 之前还是之后写入，所以每次清理前先让出一个 macrotask 再读取状态。
- **id 来源：** relay 的 message id 取自 `createUserMessage` 生成的稳定 id。重载恢复路径重新 relay 时会记录新的 id。

## 4. 4.4 的边界

| 场景 | POSIX | Windows |
|---|---|---|
| timeout/abort 时 shell 的子孙进程 | 整个进程组被 SIGTERM，结束时补 SIGKILL | shell 存活期间 `taskkill /T /F` 尽力回收 |
| check 正常退出后留下的后台进程 | `reapGroup` 回收（只对 check 开启；git 命令不开启） | 无法回收（没有 job object；父进程退出后 `/T` 找不到进程树） |
| 自己调用 setsid 脱离进程组的进程（daemonize、`setsid`、docker） | 不受管控 | 不受管控 |

## 5. 4.2 的边界

- **seed 本身仍是顺序读取**，只是不一致能被检测到：前后指纹相同，说明在 git 能观察到的范围内，复制期间源没有变化。
- **指纹的盲区：** 指纹的内容摘要有预算上限，超出预算的大文件只比较大小，同等大小的修改可能检测不到。
- **起点的含义：** 所有候选共享的起点是“seed 时刻的源”，而不是候选开始运行时的源。这是有意的：公平比较需要一个共同的过去快照。

## 6. 修复前后的行为证据

`scripts/tests/lifecycle.test.mjs` 在基线（`d28f656` 的 worktree 构建）上 **1/14**，本轮 **14/14**。基线缺少两个导出（`runProcessCapture`、`PREFLIGHT_OK_TTL_MS`），只对这两个做了桩处理。唯一在基线上通过的那条，是“源已消失时无条件清理”的守卫测试，它本来就应在新旧代码上都通过。

| 场景 | 基线 | 本轮 |
|---|---|---|
| relay 还在 inbox 中排队时来了一次 idle | winner 工作区被删（断言 `idle with the relay still queued must not remove the winner it points at` 失败） | 保留；relay turn 结束后的 idle 才审计和删除 |
| `sh -c "sleep N; echo"` 超时 | `sleep` 存活 | 0 个存活 |
| check 用 `&` 留下后台进程 | 存活 | `reapGroup` 回收；未开启该选项的调用不受影响 |
| 子进程不读 4 MiB stdin 就退出 | （裸 `spawn` 复现）宿主进程以 `Unhandled 'error' event: EPIPE` 退出 | 返回子进程自己的退出码 |
| 两次 prepare 之间源仓库改了文件、提交了 commit | c1 拿到的是活的源（`tracked.txt: c1 must see exactly what c0 saw` 失败），而且 HEAD 不同 | c1 与 c0 逐字节相同、HEAD 相同；`workspaceSeed.consistent: true` |
| seed 快照中途源仓库发生修改 | 不检测 | 重做快照（attempts 2）；持续变化时 attempts 3，记录 `consistent:false` |
| key 值轮换 | 仍沿用旧的“已验证” | 重新验证 |
| 验证结果超过 30 分钟 | 永久有效 | 重新验证 |
| 采样进行中时候选全部结束 | select 在采样仍占着管道时发出（`inFlightAtSelect = 1`） | 先中止并排空采样（`inFlightAtSelect = 0`） |
| busy 跳过 | 只有一条通用警告 | `/state.autopilotSkipped` 加计数器，面板可见 |

## 7. 决策表

验收要求：4.1 和 4.4 必须有回归测试并修复，其余给出决策。

| # | 决策 | 否决的替代方案 | 理由 |
|---|---|---|---|
| 4.1 | 修复：清理时按 agent 状态和 inbox 判断 | 给 idle 打序号 / 改用 `whenIdle()` | 序号挡不住 cancel 收敛的 idle；`whenIdle()` 只表示整体静止，“不能标识某条消息何时结算”（契约原文） |
| 4.4 | 修复：POSIX 进程组；check 开启 reapGroup | 对所有调用都开启 reapGroup | git 不会故意留下后台进程；只对执行候选代码的 check 回收，范围最小 |
| 4.2 | 修复：单一 seed，检测不一致并重试，最后打标 | 在 prepare 期间暂停源 turn | autopilot 的原则是“绝不扣住源 turn”（`host.ts` 注释）；把源 turn 的延迟换成公平性，不划算 |
| 4.3 | 只做可观测：`/state`、计数器、面板 | 排队等候；往会话里发通知 | 排队会让任务上下文过时，并占用一整套候选资源；会话通知每次都会多唤醒一个源 turn、消耗模型调用（与 `selectionNotify` 的结算通知同理），**交给负责人决定** |
| 4.5 | key 值指纹加 30 分钟 TTL | 每次 selection 都重新 preflight | 一次 preflight 是一次极小的比较请求，30 分钟一次的成本可以忽略；每次都做会给每个 selection 增加一次往返 |
| 4.6 | ranking 前中止并排空采样 | 为 progress 单独开一个 sidecar 进程 | progress 只能显式开启，preflight 发生在 rollout 之前，唯一的重叠窗口就是“采样中 → ranking”；多开一个 Python 进程的内存代价不值得 |
| 4.7 | 合并为一个 spawn 核心，加守卫测试 | — | 两套实现已经在 kill 升级、EPIPE 和 flush 三处出现了漂移 |

## 8. 残余风险

- **4.1：**
  - 依赖 DSH 的 `status`/`inbox` 契约；没有这两个字段的宿主退回旧行为。
  - 源 agent 在 relay 之后再也不进入 idle（挂死）时，winner 会一直保留到 dispose，与之前相同。
  - 用户取消 relay turn，等同于 relay 已经结束。
  - relay id 只保存在内存中。
- **4.4：**
  - Windows 上无法回收已经脱离的孙进程。
  - 自行 setsid 的进程不受管控。
  - 结束时补的 SIGKILL 可能打断孙进程自己的 SIGTERM 清理。
  - 进程组 id 被复用在理论上可能（组长退出且组内已空之后的极短窗口）。
- **4.2：** 指纹预算之外的同等大小修改检测不到；每个 selection 多执行两次源仓库 `gitDiffStat`。
- **4.3：** 跳过记录只保存在内存，不落盘；会话内不提示。
- **4.5：** TTL 是常量，不可配置。
- **4.6：** 采样被中止时，select 要承担一次 sidecar 重新启动的开销；测试用的是 fake bridge，真实 bridge 的 teardown 路径由已有的 bridge 测试覆盖。
- **4.7：**
  - 读取 stdin 的 check 现在会立即读到 EOF（之前是阻塞到超时）。
  - 4.7b 的测试用 node 子进程复现，没有直接走 `git apply` 路径。

## 9. 兼容性影响

- **新增字段：**
  - `SelectionRecord.workspaceSeed`；
  - `StateResponse.autopilotSkipped`（服务端总会返回；面板对旧服务端做了容错）。
- **新增或扩展的 API：**
  - `PREFLIGHT_OK_TTL_MS`（导出）；
  - `ModelProberOptions.okTtlMs`；
  - `RunProcessOptions.input/reapGroup`；
  - `runProcessCapture`；
  - `WorkspaceManager.seedReport?`（可选）；
  - `IsolatedWorkspaceManager` 构造函数第 3 个参数（仅测试钩子）；
  - host 侧 `Agent` 类型的可选字段 `status`、`inbox`。
- **行为变化：**
  - winner 保留到它的 relay 被消费之后才清理；
  - 候选一律从 seed 复制；
  - 每 30 分钟最多多一次 preflight，每个模型最多多一次探活；
  - check 的 stdin 立即 EOF，留下的后台进程会被回收；
  - busy 不再写入 `autopilot.admission` 警告。
- **文档同步：** `README.md`、`HANDOFF.md`（两处）、`bridge/PROTOCOL.md` 中关于孙进程和 preflight memo 的过时描述已改正。

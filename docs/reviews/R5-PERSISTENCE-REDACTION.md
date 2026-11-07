# R5 审查报告：持久化、审计包、脱敏与协议契约

- 基线：`10ea4f4`（R4 之后），审查分支 `arena/01a0d1de-dsh-verifier-autopilot`，PR #5
- 计划：`docs/REVIEW-PLAN-2026-09-24.md` §R5
- 提交：`9cd2008`（5.1/5.3/5.4/5.6 修复与测试）、本报告所在提交（ledger 模糊测试、legacy 出口对齐、注释与文档同步）
- 回归测试：`scripts/tests/egress-persistence.test.mjs`，10 个测试；`bridge/self_test.py` 新增门禁 (i) `error_taxonomy`，9 个用例；`bridge.test.mjs` 的 PROTOCOL.md/fixture 字段一致性检查扩展到 health
- 门禁：`check:architecture`、`typecheck`、`build:host`、`build:client` 全绿；`npm test` **314/314**（R4 之后 304，新增 10）；`bridge/self_test.py` 14 PASS / 1 SKIP（SKIP 是需要真实 `llm_verifier` 的 mojibake 门禁，与 R4 相同）；`git diff --check` 干净
- 已有测试的改动：① `trust-boundary.test.mjs` 只改了 `scrubSecretEnv` 的 import 路径（函数从 `proc.ts` 移到 `util.ts`，见 §3.1），断言未动；② `bridge/protocol-fixtures.json` 的规范 select 帧 `n_evaluations` 由 4 改为 1，这正是 5.4 修掉的那个兜底值
- 约束：本轮没有产生任何 provider 调用

## 1. 目标与方法

R5 关心的是数据**离开进程**的那一刻：发给 verifier 的请求，写进磁盘的 ledger 和审计包，回到源会话的 relay，以及本机 HTTP 接口。做法：

1. **枚举出口，再逐一核对脱敏**（§2）。从每个 `fetch`、`writeFileSync`/`appendJsonlLedger`、sidecar 帧、relay 文本和 `/state` 字段出发倒推数据来源，而不是从“哪里调用了 `redactSecrets`”出发。
2. **先复现。** 5.1 用一个把 `env` 打印进轨迹的假候选，在 verifier 请求、记录、审计包和 relay 四处找 secret 的值；ledger 用 `/tmp/r5/ledger-probe.mjs` 复现了截断尾行（P1）和高版本行在压缩时被删（P2），再把两者写成测试。
3. **ledger 模糊测试**：固定种子，300 轮，随机插入垃圾行、高版本行、重复行，随机删行，一半的轮次在随机字节处截断（模拟写到一半时崩溃）。不变式：加载不抛错；结果等于“每个 id 最新的一条有效行”，不凭空产生记录；损坏之后追加的一行一定能读回，并且不丢任何旧记录；压缩可往返；能解析的高版本行在压缩后保留。
4. **协议逐字段比对**：sidecar 实现、`protocol-fixtures.json`、`PROTOCOL.md`、stub、bridge 解析器五方对照。
5. **同一份测试跑基线**（§6）。

## 2. 出口清单与脱敏矩阵（验收项）

“字面量”指本次 selection 的 verifier key，加上所有名字符合凭据规则（`SECRET_ENV_NAME`）的环境变量中长度 ≥ 8 的值，按长度从长到短替换；“模式”指共享的 token 模式（`sk-…`、`Bearer …`、`<名字>_API_KEY=…`、`"password": "…"` 等）。

| # | 出口 | 去向 | 携带的内容 | `10ea4f4` | 现在 | 位置 |
|---|---|---|---|---|---|---|
| E1 | select 请求 | 网络（verifier 中转） | problem、criteria、groundTruthNote、每个候选的 preface 和渲染后的轨迹 | **无** | 字面量 + 模式 | `candidates.ts:998-1001`、`:856` |
| E2 | progress 采样请求 | 网络 | problem、轨迹末尾 12000 字符 | **无** | 字面量 + 模式 | `candidates.ts:733-734` |
| E3 | `SelectionRecord` | ledger、`/state`、SSE、`GET /selections`、审计包 `record.json` | `finalists[].handoff`（由轨迹派生）、`checks[].outputTail`、`cand.error`、`record.note`、`record.error` | **无** | 字面量 + 模式（handoff 由已脱敏的轨迹派生） | `candidates.ts:678`、`:825`、`:832`、`:891`、`:1036`、`:1117`、`:1150` |
| E4 | 审计包 `traces/c*.txt` | 磁盘 | 每个候选完整的渲染轨迹 | **无** | 同 E1（写入的是 runner 返回的已脱敏 artifacts） | `selection/host.ts writeArtifact` |
| E5 | 审计包 `diffs/c*.patch` | 磁盘 | 候选的完整补丁和未跟踪文件名 | **无**，且补丁相对 HEAD（5.6） | 字面量 + 模式；有起点基线时只含候选自己改过的路径 | `candidates.ts:869`、`live.ts gitDiffFull` |
| E6 | relay 消息 | 源会话（进入源模型的上下文） | winner handoff、note、补丁摘要 | **无** | 来自 E3，已脱敏 | `autopilot.ts buildAutopilotRelay` |
| E7 | legacy verifier 提示 | 网络 | 会话提示 | 模式 + 本次 key | 字面量 + 模式（与选择路径同一个 redactor） | `verifier.ts:236` |
| E8 | 诊断 | 内存环形缓冲 → `/state.diagnostics` | 异常信息、detail 字符串 | 只有模式 | 模式 + 环境变量字面量 | `diagnostics.ts:90`、`:144` |
| E9 | HTTP 500 响应体 | 本机 HTTP | 内部异常信息 | 只有模式 | 模式 + 环境变量字面量 | `api.ts:169` |
| E10 | sidecar 错误信息 | sidecar → bridge → 记录 | provider 异常文本 | sidecar 内用本次 key 脱敏 | 不变；进入记录时再经过 E3 | `llm_verifier_sidecar.py` |
| E11 | check 和审计子进程的环境 | 执行候选编写的代码 | 宿主环境变量 | R1 已清洗 | 不变（规则与 E1–E9 共用同一个 `SECRET_ENV_NAME`） | `util.ts scrubSecretEnv` |
| E12 | `/state`、SSE 中的配置和路径 | 本机 HTTP | `configSnapshot`（含 `sourceCwd`）、工作区路径 | 明文 | 明文，属于设计内容；secret 内容已在上游 E3 去除，访问控制见 §3.5 和 §7 | `api.ts:222`、`:377` |

不在矩阵内的：select 帧里的 `api_key` 字段本身（必须是原值，sidecar 用它调用中转，也用它给自己的错误信息脱敏）；ledger 的磁盘权限（沿用 DSH 数据目录的权限）。

## 3. 发现与处置

| # | 严重度 | 发现 | 处置 | 位置 |
|---|---|---|---|---|
| 5.1 | **高** | **选择路径没有任何出口脱敏**（E1–E6）。候选的工具调用继承宿主的完整环境，`env`、`cat .env`、`npm test` 打印的配置都会原样进入轨迹，然后被发往第三方中转、写进 ledger 和审计包、经 `/state` 广播，最后作为 relay 回到源模型的上下文。共享模式还漏掉了带前缀的名字：`OPENAI_API_KEY=…`、`DATABASE_PASSWORD=…`、`"client_secret": "…"` 都不命中，因为原正则要求关键字前有词边界 | 每次 selection 一个 redactor（`makeRedactor`）：字面量 + 模式，覆盖 E1–E6；模式增加可选的名字前缀、`access_key` 和引号后的 `:`/`=`。关键字后必须紧跟可选引号和 `:`/`=`，所以 `tokens: 12`、`tokenizer=`、`password_min_length` 不会被误伤。`scrubSecretEnv` 和凭据名规则移到 `util.ts`（`proc.ts` 必须保持只依赖 Node 的叶子模块），清洗环境和脱敏共用一份规则 | `util.ts`、`candidates.ts` |
| 5.3 | **高** | **ledger 截断尾行吞掉下一次写入**（P1）：崩溃留下一行没有换行符的残缺 JSON，重启后的第一次 append 直接接在它后面，两行合成一行解析失败，**崩溃后第一条完整记录也一起丢失**。追加和原子替换都不 fsync，掉电语义没有说明；`atomicWriteFile` 在 rename 前不 fsync，掉电后可能得到空文件，也就是**整个 ledger 被清空** | append 用 `a+` 打开，最后一个字节不是 `\n` 时先补换行，写完 `fdatasync`；`writeSync` 改为循环直到写完；原子替换先 fsync 临时文件，再 rename，再尽力 fsync 目录（win32 跳过）。掉电语义写进 `ledger.ts` 文件头（§4） | `ledger.ts` |
| 5.3b | 中（新） | **降级会删除新版本的历史**（P2）：读取时跳过 `v > LEDGER_VERSION` 的行是对的，但压缩只用已知记录重写文件，所以旧版本插件只要压缩一次，新版本写下的所有行都被永久删除 | 压缩时把能解析的高版本行原样追加在已知记录之后，上限 1 MiB，超出时保留最新的 | `ledger.ts foreignRows` |
| 5.3c | — | 计划问题：超过 4 MiB 时 `persist()` 的压缩分支是否一定包含当前记录 | **确认包含**，已有测试固定下来 | `selection/host.ts persist` |
| 5.2 | 低 | 同一 selectionId 写多行（running、终态、relay、审计、丢弃），以最后一行为准；丢弃时原地修改记录，与注释“settlement attribution stays immutable”的字面意思不符 | **保留“最后一行为准”**（读取方本来就按 id 去重取最新）。核对后确认 settle 之后的写入只改生命周期字段：`timing.relayedAt/auditedAt`、`sourceAtRelay`、`delivery`、`discardedAt`，裁决、finalists、排名和归因都不变。测试逐行比对每一条 ledger 行的裁决字段；注释改为准确描述 | `selection/host.ts`、`host.ts` |
| 5.4a | 中 | **没有协议版本**：bridge 无法发现旧的或别处的 sidecar 脚本，只能看它对帧的理解是否碰巧一致。`PROTOCOL.md:35` 链接到 `#health-response`，但这一节**根本不存在**，health 的字段从未写进文档 | health 返回 `protocol: 1`；bridge 每次 spawn 都先发 health，版本不同或缺失时以不可重试的 `bridge_protocol` 结束子进程，排在它后面的请求一起失败，并报 `sidecar.protocol_mismatch`。补写 Health Response 一节；字段一致性测试扩展到 health | `bridge.ts probeWarmup`、`llm_verifier_sidecar.py`、`PROTOCOL.md` |
| 5.4b | 中 | **`_map_exception` 用子串决定是否可重试**：`"logprob" in str(exc)` 排在类型判断之前。中转的 429/503 正文或超时信息只要回显了请求参数（`logprobs=true`），就被判为**不可重试**的 `missing_logprobs`，一次临时故障变成“这个 verifier 永远不能用”。`JSONDecodeError` 是 `ValueError` 的子类，provider 返回的无法解析的回复因此被判为调用方的 `invalid_request` | 先按类型判断：openai 的超时、连接错误、429/5xx 都可重试；只有 400/422 并且提到 logprob 才是 `missing_logprobs`；`RuntimeError` 只认上游真实的报错形状（`returned no answer logprobs`）；`JSONDecodeError`/`UnicodeDecodeError` 归为可重试的 `provider_error`；最后才是普通 `ValueError` → `invalid_request`。门禁 (i) 用假的 `openai` 模块（类层次与真实一致）覆盖 9 种情况 | `llm_verifier_sidecar.py`、`self_test.py` |
| 5.4c | 低 | K（`n_evaluations`）有**三个**缺省值：配置 1；runner 在嵌入方没有提供 `nEvaluationsDefault` 时回落 2（verifier 调用量翻倍）；bridge 被直接调用时回落 4 | 统一为 `DEFAULT_SELECTION_EVALUATIONS = 1` | `constants.ts` |
| 5.5 | 中 | `/state` 和 SSE 不需要鉴权（POST 需要 token），会广播配置、本机路径，以及 5.1 之前未脱敏的 handoff 和 `outputTail` | **secret 内容已在源头去除**（5.1，E3）。不另做裁剪视图：`GET /selections` 本来就按需返回完整记录，只裁剪推送内容几乎不减少暴露面，却会让两个接口的数据形状不一致；仓库内的读取方（面板、`eval/run.mjs`）都不读这些字段。读取鉴权和 Host 白名单会改变远程访问方式，列入 §7 等待负责人决定 | `api.ts` |
| 5.6 | 中 | （R3 转入）审计包的补丁相对 HEAD，会把用户在源仓库里**尚未提交的改动**连同候选的改动一起打包，审计者分不清哪些是候选写的，脱敏范围也包含了这些与候选无关的内容 | 有起点基线时，`gitDiffFull` 只对候选自己改过的路径生成补丁（`:(top,literal)` pathspec），未跟踪文件也只列候选自己的；记录 `scope` 和 `inheritedExcluded`，写在补丁文件末尾。路径超过 400 个或 pathspec 超过 16000 字符时回落到相对 HEAD（`scope=head`），并如实标注 | `live.ts gitDiffFull`、`selection/host.ts writeArtifact` |

## 4. ledger 的掉电语义（写进了 `ledger.ts` 文件头）

- `appendJsonlLedger` 返回之后，这一行已经 `fdatasync`：掉电最多丢失**正在写的那一行**，不会丢失已经返回的写入。
- 正在写的那一行可能留下残缺的尾行：加载时跳过它（经 `onSkippedRow` 报出），下一次追加先补换行，不会被吞。
- 压缩是“写临时文件 → fsync → rename → fsync 目录”：重载只会看到旧文件或完整的新文件；**不会再出现空文件**。
- 残余：ledger 文件**第一次被创建**时，append 不 fsync 父目录，掉电可能让这个新文件整个消失（此时它只有一行）。Windows 上不 fsync 目录。
- 能解析的高版本行不被解释，但压缩会保留它们，上限 1 MiB（§3 5.3b）。

## 5. 5.1 的设计边界

- **字面量来自哪里**：本次的 verifier key，加上进程环境中名字像凭据的变量的值。只在 DSH 的 credentials 里、从不进入环境的 key，只有本次 verifier 使用的那一个会被字面量覆盖；其他的依靠模式匹配。
- **长度下限 8**：太短的值（`PASS=1`）作为字面量替换会把正文改得面目全非，所以只靠模式处理。
- **改写的是证据，不是候选**：工作区里的文件不动，winner 交付的仍是原始改动。被脱敏的只是轨迹、补丁和输出这些进入 verifier、磁盘、会话的副本。代价是：如果候选的正确性恰好取决于某个 secret 字面值，verifier 看到的是 `[REDACTED]`。这一点是有意为之的取舍。
- **5.6 的残余**：候选也改过的文件中，用户已有的未提交 hunk 仍在补丁里（按路径过滤，不是按 hunk）。超过 400 个路径时整个补丁回落到相对 HEAD，并标注 `scope=head`。

## 6. 修复前后的行为证据

| 证据 | `10ea4f4` | 现在 |
|---|---|---|
| `egress-persistence.test.mjs`（模糊测试之外的 9 个） | 2/9（只有两个“确认现状”的测试通过：5.3c 压缩包含当前记录、5.2 只改生命周期字段） | 9/9 |
| ledger 模糊测试（300 轮） | 第 0 轮就失败：截断尾行之后追加的那一行读不回 | 300/300 |
| `self_test.py` 门禁 (i)，9 个用例 | 错 4 个：503、429、超时三种回显了 logprobs 的情况全部变成不可重试的 `missing_logprobs`；无法解析的回复变成 `invalid_request` | 9/9 |
| 字段一致性测试（health） | 失败：`PROTOCOL.md` 没有 Health Response 一节 | 通过 |
| 5.1 端到端：四种 secret（verifier key、只存在于环境变量 `R5_SERVICE_TOKEN` 中的值、无名字的 `sk-…`、`DATABASE_PASSWORD=` 赋值，其中最后一个也出现在用户的 problem 里）被候选写进轨迹、check 输出和补丁 | select 请求、progress 请求、记录、`traces/`、`diffs/`、relay 七处都能找到原值 | 七处都找不到；select 请求里原位置是 `OPENAI_API_KEY=[REDACTED…`，`TOOL CALL bash` 等证据仍可读；请求的 `apiKey` 字段保持原值 |

## 7. 决策表

| 事项 | 本轮做法 | 需要负责人决定的 |
|---|---|---|
| 5.5 读取接口的访问控制 | 不改；secret 内容已在上游去除 | 推荐：设置了 token 时，`GET /state`、`/events`、`/selections` 也要求 token（面板本来就带）；另加 Host 头白名单（默认只允许 loopback 名称，可以配置），防御 DNS rebinding。两者都会影响远程访问 DSH 面板的用户 |
| 5.2 多行记录 | 保留“最后一行为准”，固定“只改生命周期字段”这一不变式 | 无 |
| 5.4 版本不匹配 | 直接失败（不可重试） | 无；以后改协议时同步改 `PROTOCOL_VERSION` 和 `SIDECAR_PROTOCOL_VERSION` |
| 5.1 字面量范围 | 凭据名规则与 R1 的环境清洗共用 | 如果需要覆盖不在环境中的其他凭据，需要 DSH 提供 credentials 枚举接口 |

## 8. 残余风险

- 被淘汰出 ledger 窗口的旧记录，其 winner 工作区如果仍然保留，就无法再 discard（只影响非常老的记录，本轮只记录不修）。
- ledger 文件第一次创建时不 fsync 目录（§4）。
- 模式脱敏本质上是黑名单：没有凭据形状的 secret（比如一段自定义格式的口令，又不在环境变量中）不会被识别。
- 5.6 的残余见 §5。

## 9. 兼容性影响

- sidecar 和 bridge 必须一起升级：旧 sidecar 的 health 没有 `protocol`，新 bridge 会拒绝它（这正是 5.4 的目的）。仓库内两者同步发布。
- 直接调用 bridge 且不传 `nEvaluations` 的嵌入方，K 从 4 变为 1；runner 在缺少 `nEvaluationsDefault` 时从 2 变为 1。经 Host 配置的正常路径不受影响（配置缺省本来就是 1）。
- `redactSecrets` 的模式变宽：`NAME_API_KEY=…` 这类赋值现在会被脱敏。依赖原文的读取方（没有发现）会看到 `[REDACTED]`。
- 审计包补丁在有基线时变小，并在末尾注明 `scope`；读取方如果假定补丁“相对 HEAD”，应改看这个注明。

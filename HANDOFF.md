# dsh-verifier-autopilot 交接说明

> 当前权威快照：2026-09-17 午后（HEAD=文档提交，verifier-autopilot 代码自 f4d20f3 未动：8bb15f7 候选控制加固 + f4d20f3 中转号池执行模式 + HANDOFF 文档提交链，enabled=false/selectionMode=off 为既定 live 态；另有 dsh-llm-retry-settings **0.2.3** 主模型侧扩展，**已首次 git 版本化**：1b3a69f→1302747→4b1494e，见下方 2026-09-17 批次）。实现仓库：D:/tools/dsh-plugins/dsh-verifier-autopilot。参考目录：D:/tools/llm-as-a-verifier-main，只用于理解上游算法；该目录当前不是 Git checkout，不能当作生产实现或当前事实。
>
> 当前修复摘要（源码默认 + live /state 双口径）：verifier nvidia/nemotron-3-super-120b-a12b（2026-09-13 严格协议实测：HTTP 200 + score tags + logprobs，约 6s；GLM-5.3-Flash 因 effort=max 思考过长已撤下默认）；候选池 nvidia/nemotron-3-super-120b-a12b 优先；quality-first + 探活剔除死项；模型 ID 由 operator 自由配置，provider catalog 仅作发现信息，自定义 ID 也会直接探活；源码默认 selectionMode=auto、standard N=2/K=1/P=0、deep N=3/K>=2、verifier effort=low、autoFeedback=false；**settings.yaml 持久层当前压过源码默认：selectionMode=always、P=0、effort=max、autoFeedback=true、model 与 selectionModels=moonshotai/kimi-k3**（operator 既有嗜好，未经确认不回滚；2026-09-16 实测回读：P 已由 1 改 0；verifier 与候选池当前均为 operator 自选的 kimi-k3 单点，与源码默认 nemotron 不同，见 §4 表）；margin gate=0.03 仍 provisional（毕业改走 max-with-margin 条件单 docs/MARGIN-GRADUATION-INVOICE.md，q95 跨轮 20% 准则已按统计诊断退役）；candidate timeout 默认 600s（2026-09-10 抬界裁决，commit 9927986）；自动 selection 后台运行；winner/fallback 在 source idle/detach/dispose 时回收；审计包在清理前落盘；verifier 调度恒等式 `calls = nComparisons × criteriaCount × K` 已入档 docs/VERIFIER-SCHEDULER.md，新 record 带 criteriaCount/expectedVerifierCalls 遥测（commit 32a67ed）。
>
> 当前门禁（2026-09-16 实测，HEAD=f4d20f3）：build complete / **203 tests 全过**（含 source-cwd-required 回归 + 号池执行模式 7 项：workers 矩阵、config API 范围、lane 分层、平滑间隔、selhost 作用域透传）/ bridge self-test 10/10 全 PASS（含 resilient_client 门）/ git diff --check 通过。
>
> **2026-09-16 中转站号池执行模式**（operator 澄清：号池在 chat.holisthoom.top 中转站内、按请求轮询分号；插件侧单入口 key）：串行链永远撞「当前账号」，卡住即整链停——插件侧并发才是真正取号。三旋钮：`selectionVerifierWorkers`（锦标赛并发，0=auto 4，恒等式 calls=nComparisons×criteriaCount×K 不变，只改墙钟）、`verifierMinIntervalMs`（lanes+sidecar 共享令牌桶平滑，0=关）、`verifierSmallModel`（机械 lane completion/evidence 分层小模型，opt-in）；sidecar 内每调用 429 快重试 ≤2 次（300/900ms backoff，轮询已前进、重试即换号），非 429 保持原 Node 侧重试语义。
>
> **主模型侧同步扩展（dsh-llm-retry-settings 0.1.3 → 0.2.0，同日）**：官方 @deepseek-ai/dsh-llm-retry 引擎本就默认重试 RATE_LIMIT（maxRetries=5、500ms→10s 退避、尊重 Retry-After）；0.2.0 给设置卡片新增 `applyToProviders`（重试覆盖按 provider 作用域，空=全部，可只勾 kimi）、`smoothEnabled/smoothProviders/smoothMinIntervalMs`（agent/request 瀑布按 provider 命中共享令牌桶，推迟返回即推迟派发——多流并发摊匀）。GUI 已验证全字段渲染（设置→General→LLM 自动重试）；离线冒烟脚本 D:/tools/_trace-dump/dsh-llm-retry-smoke.mjs 全过；已 dev_reload_package 热重载生效（fiber 173205cd）。**注意（2026-09-17 已更新）：该目录已就地 git init 并版本化（main：1b3a69f 磁盘快照→1302747→4b1494e；origin=https://github.com/zeng6125-rgb/dsh-llm-retry-settings.git 已建未 push）**——「0.2.0/0.2.1 改动只在磁盘+live」的风险已闭环；回传上游仍可选。
>
> **2026-09-16 深夜第二批：断流诊断 → stream-guard 自动续跑（0.2.0 → 0.2.1）**。诊断证据（本会话 journal session-ad7396f3，模型 z-ai/glm-5.3@kimi/max、maxTokens 64000——**会话模型以 journal request/header 为准，勿以 GUI 底栏另一会话的模型选择器为准**）：上午段 69 次 `pi-ai stream idle timeout after 300000ms`（code=TIMEOUT，全部在 0.2.0 热重载前；llm-retry 以 ~5:01 节奏重试并恢复——300s 空闲超时对卡死型故障太长，见 §8 待办 9）；下午交接段三次「文本悬在冒号处截断」journal 证据是 **finish kind=stop**（turn 9/10，13:38/13:41/13:45）——clean stop 不是错误，request-error 重试架构上覆盖不到。0.2.1 补 turn 级看门狗：新键 `continueOnPrematureStop`（operator 已开并持久化 true）+ `maxAutoContinues`（1..5，默认 2，默认值不落盘）；agent/status idle 时查 journal 尾部——finish=stop 且末条回复无工具调用、文本悬在 ：，、（「"[{ —— 断点、≥16 字 → `agent.followup` 注入「继续（从中断处续写，勿重复）」（source.kind=plugin、form=continue）；人工新消息重置计数、turn/interrupt 绝不续跑、候选子会话 attach 时即跳过（初版把拦截写在判定里、attach 泄漏给每个候选——冒烟场景揪出后前移修掉）、<16 字短答案防误触。冒烟 +8 场景全过（_trace-dump/dsh-llm-retry-smoke.mjs）；热重载 + GUI 渲染 + settings.yaml 持久化三链闭环。**经验：热重载带新配置键后，已打开的设置页 scope 仍绑旧 schema，保存会 settings-rejected——刷新页面重绑即解。**已知边界：非断点字符（半截单词）截断、工具调用已发出后的中断不覆盖。
>
> **deepseek-v4.1-flash（小红书/xaohongshu 供应商，operator 09-16 新加）验证判定**：走真实 lane 路径的严格协议探活（POST /api/probe，临时切 model+apiKeyEnv=XAOHONGSHU_API_KEY，探后已恢复 moonshotai/kimi-k3 + KIMI_API_KEY）——HTTP 200、标签可产、**token logprobs 缺失（missing_score_logprobs）**，77.4s/次@effort=max。结论：**不能当 Verifier**（严格模式两链同判；锦标赛 preflight 会以 missing_logprobs 拒入），当主模型可用（走 host openai-responses 适配，不需要 logprobs）。要升级为 verifier 需上游/中转侧开 logprobs 透传。GUI MODEL_OPTIONS 的 deepseek-v4-flash 选项挂的是 DeepSeek 官方 API（DEEPSEEK_API_KEY），与小红书供应商无关，勿混淆。
>
> **2026-09-17 批次：60s 看门狗事故 + 小红书 Responses 异常样本 → stream-guard 0.2.2/0.2.3（dsh-llm-retry-settings 首次 git 版本化）**。全部证据出自本会话 journal（session-9b97af82，存档 D:/tools/_trace-dump/quote-audit/session.jsonl）+ settings.yaml 实读 + 源码逐行。
>
> 1. **git init（风险项闭环）**：D:/tools/dsh-plugins/dsh-llm-retry-settings-0.1.3 原无 git；已 init（main，首提 1b3a69f=磁盘+live 状态快照，origin 已建未 push）；仓库级 identity 复用基线提交的 dsh-agent <agent@dsh-local>（全局未动）。
> 2. **60s 看门狗事故（我方改动引入的本地掐断，已回滚）**：09-17 01:41 按先前建议把 llm-pi-ai `providers.*.streamIdleTimeoutMs` 300000→60000（7 providers）——随后 journal 出现 **9 条真实 `finish kind=error`，全部=`pi-ai stream idle timeout after 60000ms`、全部在改动之后**；10:28–10:34 六分钟 6 条（间隔 61/61/61/60.5/60.5s）=同一卡住请求 1 初始+5 重试（当时 maxRetries=5）逐次被 60s 掐掉——这正是 operator 目睹的「一直开始截断」。**已回滚 300000**（备份 settings.yaml.bak-20260917-110819）。教训：**步内 chunk 间隔统计（≥60s 恰 9 个、≥300s 为 0）混入了重试与非网络活动，不能当网络原始间隔**——「9 个长间隔证明 9 条健康流被误杀」的说法已撤回；未来收紧阈值必须从真实网络间隔包络数据化，不拍脑袋。
> 3. **小红书 Responses 异常样本（assistant/message seq=49814，turn 11/step 1）**：xaohongshu/deepseek-v4.1-flash 走 **openai-responses** 接口——reasoning 与 text 两块**完全相同**（各 14136 字符：规划文字被重复放进正式正文），finish kind=stop、无工具调用、已宣告的工具调用未发生。**曾用 openai-completions 的 finish_reason 语义解释它——接口搞错，已纠正**。Responses 收尾语义（openai-responses-shared.js mapStopReason L621-641）：completed/incomplete/failed/cancelled 按 response.status 映射；**缺 status、queued、in_progress 也本地映射为 stop**；无终止事件才抛 "stream ended before a terminal response event"。故 journal 的 kind=stop **不等于**上游发来正确完整结束信号；原始 SSE 未捕获，重复内容根因（中转协议转换 vs 模型输出 vs 本地适配）**未定**。#24385（11:08:59，号池 workbuddy，503 no_healthy_account、上游 429 额度用尽 codebuddy 14018）本地记 502——状态不一致保留原样；本地链 llm/retry→llm/retry-started→成功工具调用，即该次是号池单次失败记录，**不是重试路径故障**；「两个不同中转上游不太可能是同一个错误」的 operator 质疑成立，共用本地链路才是嫌疑面。
> 4. **0.2.2 → 0.2.3**：0.2.2（1302747）补 textless clean stop；0.2.3（4b1494e）新增 `lib/stop-recovery.js` `inspectStop()`——只看最近 turn、finish 与 message 须同 turn/step 配对；interrupt/interrupted/aborted/error turn/新用户输入/turn 边界/step 不匹配一律不触发；三类判定：`textless-stop` / `duplicated-reasoning`（≥256 字符 reasoning 与 text 精确相等）/ `dangling-tail`（≥16 字悬空断点）；`handledFinishes` WeakSet 同一 finish 事件去重；恢复文案按原因区分（duplicated-reasoning 用专用文案：核对已完成工具结果、继续未竟任务、勿重复规划文字）；followup 失败从静默吞掉改为 logger.warn。测试 `test/stop-recovery.test.mjs` 7 组全过；**seq=49814 真实事件离线回放**：识别 duplicated-reasoning、两次 idle 只入队 1 次、零网络请求。热重载 0.2.3（清 2 模块、重建 2 fiber、active）。范围/证据边界/回滚见插件内 RECOVERY-0.2.3.md。
> 5. **诚实边界与撤回记录**：(a) 已撤回：「9 个长间隔证明健康流被杀」「供应商明确发送 finish_reason: stop/end」「根因已闭环」多次宣称；(b) 0.2.3 的 duplicated-reasoning 启发式**尚未经过下一次真实上游故障的 live 验证**；假阳性类=模型把长 reasoning 原样当正文复述（maxAutoContinues=5 兜底）；(c) 本会话我方 8 次悬空尾截断（全部 kimi/glm-5.3，守卫接住数次），截断点集中在 text→tool_use / reasoning→text 切换帧（块边界模式），成因在上游/模型侧未定；(d) smoothEnabled 现值 true（operator 09-17 11:02 关闭后又改回，未追问）；「平滑导致频繁断」双向均未证明，11:02 的 A/B 混入三变量（平滑/模型/maxRetries）；(e) maxRetries=18（operator 值）+300s 看门狗：卡死请求最坏 ~95 分钟（1+18 次+退避），已提示未动；(f) 可选待点头：github 经 SOCKS5（socks5h://<lan-proxy-redacted>）可达——可拉 deepseek-harness blob、push 新仓库、建真 checkout。
> 6. **经验（沿袭并新增）**：journal 是唯一权威证据源，消息文本/GUI 底栏皆非权威；zstd journal 用 node zlib 解压会截成 172 字节（流式多帧），**必须用 7z**；本会话再证：把规划文字混入正文或宣告动作后不发工具调用，都会被守卫按悬空尾接住——回复应完整收句、调用块紧跟正文。
>
> ### 今晚稳定的三条证据主线
>
> 1. **自动路径首次 live 完整闭环**：sel-ac04cfd7（02:37-02:44）——autopilot 准入、双候选 rollout、单一幸存 fallback relay、finalizer 独立核实、post-audit delivered=yes（首个）、清理与审计落盘全走完。依据全部是源会话 journal + fixture git log + 落盘 artifacts，不是插件自述。
> 2. **噪声门限**：校准四轮（两模型家族、164 帧同文复核）——C0 噪声上限按轮 ≤ 0.0138 / 0.0131 / 0.0054 / 0.0131；q95 值在 0.0013..0.0102 间摆动（小样本估计噪音），但噪声上限从未越过 0.014。0;03 相对累计 max=0.01377 的裕度为 2.17×（早前口径的「≥2.2×」是向上取整的轻微高估，2026-09-10 复核纠正，不影响安全性结论）。**law 依然正确：「已校准」今天还不能说出口——`marginProvisional=true` 继续保留；毕业判定今后一律走 `node eval/calibration/graduate.mjs`（docs/MARGIN-GRADUATION-INVOICE.md 的机械化执行器）。**
> 3. **reload 丢 relay**：后台 waiter 在插件热重载时被切断，sel-ac04cfd7 曾致真实继电器丢失。已加 `recoverAutopilotRelays()`：启动时把「settled、未 discard、无 relayedAt」的 autopilot 记录补投递并重注册清理；同时 `SelectionHost.pubRecord()` 让 relayedAt/delivery 立即入 ledger + artifact，不再依赖 discard 时刻兜底。含回归测试探活 fail-closed（所有 preferred 死模型时 autopilot 拒而不是派出候选进入死单次）。
>
> 旧版逐字交接已归档到 docs/HANDOFF-HISTORY-2026-08-30.md。当前行为以本文件、源码和 live API 为准；历史数字必须保留其时间与证据边界。
### 2026-09-09 深夜批次：三次事件的裁决级证据


>
> **(1) 全链自动闭环首次落在 live 证据上 —— `sel-ac04cfd7-3c1e-4d67-88bf-825a9cbbbec3`（autopilot、standard N=2/K=1/P=1、kimi-k3×2、verifier=kimi-k3@max）**：任务「新增 timefmt.js + node:test + 提交」（source 会话 cwd=D:\tools、由任务路径解析锚定到 fixture `D:/tools/.autopilot-live-chain`）。
> - 准入分类：taskKind=code-change（systems 白名单之外的 tool/meta 不计入 has-work）。
> - 候选：c0 完成（2458 events / 15 exec tool calls / diffStat.untracked=3），c1 `candidate-timeout`（300s 撞线；kimi-k3 max effort 实证会上限 300s 内跑不完真实小任务，§6.4.4 待办记录）。
> - 单幸存者语义：**outcome=single_candidate_fallback、winnerBasis=single-candidate、ranking=null-score**，不再是「winner」。
> - relay 可靠送达：source 会话第二 turn（02:44）按 relay 契约以 finalizer 视角重新核对了真实 fixture 状态（原文可检：源会话 journal），判定候选 worktree 只是 mirror 提交、真实仓库已经具备提交，不重复集成——这是「relay 是不可信证据」语义的完整 proof-of-use。
> - lifecycle：source idle → cleanupAutopilotWinners → gitRepoState 测 HEAD 3003e9f→b1feee8（前进）→ 跑配置的 `node --test` 10/10 通过 → **delivery.delivered=yes（首个 yes）** → 审计包（当时是平面 JSON 版本，今起为目录 `{id}/{record.json,traces,diffs}`）落盘 → workspace discard。留存字段：configSnapshot、sourceHeadAtStart、timing.auditedAt、delivery。
> - 诚实边界：winner 的行为实际被 source 自身早先的直接完成覆盖（02:40 source 已直接提交 b1feee8）；selection 的正确性在本轮上**不证 ranking 质量**，只证接通与属性语义。K.4-2 教训在本轮完全复现一次（候选把提交放进了它在 workspace 内自建的 mirror git 目录）——在读到判定为 yes 的审计字段时，这条审查仍然是人的工作。
>
> **(2) 校准完成两轮（新 condition kimi-k3@low，blocklabels P-A）**：M3 于 02:36（UTC 18:36）已被 410 EOL 下线，round 2 立即换 kimi-k3 跑完 64 帧全成功——C0 五 fixture 噪声 q95=0.0102/max=0.0138（位置偏置≈0.001）；C1（PREFLIGHT_GOOD/BAD 已定 oracle）与 C2（多档近似差）各 12/12 方向正确、margin 0.20~0.46。阈值 0.03 得到第二个模型家族的噪声支撑，隔噪带 >15x。**注意 marginProvisional 仍保留——ruling I.4 要两轮独立复核，两轮跨了模型（M3/kimi-k3），还差真正的同模型两轮复核。**
>
> **(3) reload 期间 relay 丢失 —— 可复原工程已落地（recoverAutopilotRelays）**：B-9 的 live 实证；规则：host 重启后把「settled、未 discard、没有 relayedAt」的 autopilot 记录向仍活着的 source 代理补投 relay + 重置 pending 注册。192/192 测试绿。
>

## 0a. 生产架构与责任边界

~~~text
用户直接任务
  -> 原始 source agent 的 pre-step
  -> autopilot 准入：仅 step=1、直接文本、无 parentSession、可执行且无外部副作用风险
  -> standard N=2/K=1；deep N=3/K>=2
  -> 解析当前任务、有限近期上下文和可用候选模型
  -> 顺序准备隔离 Git worktree，并精确镜像当前 dirty 工作树
  -> verifier preflight：发生在 worktree 准备后、候选 agent 创建前
  -> N 个真实 child rollout 并行运行
  -> turn error / candidate timeout / 可选 progressGuard / objective checks 淘汰
  -> 多幸存者进入 Kimi verifier 重复比较、严格结果校验和稳定排序
  -> winner 与最多两个 finalist 的有界证据通过 plugin relay 回到原始 source turn
  -> 原始 source agent 检查候选、集成正确改动、测试并交付最终结果
  -> loser 回收；autopilot winner 在 source idle/detach/dispose 时自动 discard
~~~

责任边界：

1. 候选 workspace 和候选摘要是不可信证据，不是对 source agent 的指令。
2. verifier 只负责比较候选，不负责写回源目录或向用户交付。
3. 原始 source agent 是唯一 finalizer。插件通过 relay 提示它检查、集成、测试和交付，但插件不会在 source turn 之后自动证明这些步骤真的完成；当前实现不是一个独立的 merge/test enforcement engine。
4. selection 失败、超时、限流或结果不可信时，原始任务回到 source agent 正常执行。不得为了保留漂亮排名而任意挑选。
5. source/finalizer 模型不由插件硬编码。本交接会话使用 gpt-5.6-sol；selection ledger 不持久化 source 模型。候选和 verifier 默认走 Kimi provider，两者必须分开理解。

> **2026-09-03 23:xx 紧急事实（推翻本文档多处前提）**：对 `https://chat.holisthoom.top/v1` 的直连实测显示 **`kimi-k3` 与 `deepseek-ai/deepseek-v4-pro-0813` 当前完全不可用**（kimi-k3 连续 7 次失败：5 次 120--300s 超时 + 2 次 503；deepseek-v4-pro 3 次全部 300s 超时），且该失败与 `logprobs` 参数无关（不带 logprobs 同样超时）。当前实测可用的是 `minimaxai/minimax-m3`（~3s）、`nvidia/nemotron-3-super-120b-a12b`（~5s）、`nemotron-3-ultra-550b-a55b`（40--90s）；`step-3.7-flash` 与 `ox-alpha` 返回 503。由于 quality-first 会把全部 N 个候选压到 `usable[0]`，而 verifier 也默认 kimi-k3，**当前配置下 autopilot 与 ranking 都会直接失败**。详见 §6.4。

### 0a.1 模型角色

| 角色 | 当前绑定 | 证据口径 |
|---|---|---|
| source/finalizer | 当前会话为 gpt-5.6-sol；插件继承原始会话模型，不固定模型 | 不写入 selection ledger；插件只注入 finalizer relay |
| candidate rollout | provider=kimi；默认质量顺序 minimaxai/minimax-m3、nvidia/nemotron-3-super-120b-a12b、nemotron-3-ultra-550b-a55b、kimi-k3、deepseek-ai/deepseek-v4-pro-0813；默认 quality-first 将 N 个候选全部分配给第一个可用模型 | 每个候选实际 provider/model 写入 candidate record |
| ranking/verifier | model=kimi-k3（2026-09-09 探活结果：M3 已 410；kimi-k3 恢复 ~750ms）；baseURL=https://chat.holisthoom.top/v1；key=KIMI_API_KEY | verifierModel 写入 selection record；默认随 relay 存活状态迁移——以 GUI 可读 live config + 探活为准 |
| legacy five-lane verifier | 默认同为 kimi-k3（M3 于 2026-09-09 EOL），但属于旧的 verifyFive/feedback 路径 | 与 candidate ranking 语义不同，不能混用分数或证据 |

### 0a.2 质量优先决策记录（当前实现）

本轮用户明确了优化目标：token 基本免费，时间可以换质量，允许夜间长时间运行；因此第一目标是提高最终结果的质量上限，不是降低延迟，也不是让模型列表看起来足够异质。以下是当前实现与实验边界：

1. **N** 是独立候选 rollout 数。每个候选有独立 child session、workspace、工具轨迹和结果；候选生成阶段不应看到其他候选的输出。
2. **K** 是 verifier 的重复评估数（代码字段 nEvaluations）。当前自动普通档有效 K=1；deep 由策略强制至少 K=2；preflight 是 K=1 的可用性探针，不是正式排名；直接 bridge 未传值时的 K=4 只是兼容 fallback。
3. 当前自动 standard/deep 是 N=2/3，配置默认 selectionEvaluations=1；因此应写成：standard N=2/K=1，deep N=3/K=2（deep 的最小值由策略 clamp），而不是笼统地写全局 K=1。
4. **质量优先模式的实现策略**：先按配置中的质量/可靠性顺序过滤 provider 目录并选择第一个可用模型，再用该模型生成 N 个真正独立的候选；候选之间通过不同策略和审查重点制造有意义的解空间差异。不要为了形式上的异质性强制给明显较弱模型分配候选名额。
5. **异质模型不是默认价值**。它只在质量未知、模型有互补能力、需要故障/供应商冗余，或明确进行探索、成本和延迟优化时有意义。若已知同一供应商内存在稳定质量排序，弱模型候选可能降低质量下限、增加尾延迟，并让 verifier 比较低价值候选；模型列表有多个模型本身不是质量提升证据。
6. 当前用户提供的 Kimi 供应商经验排序为：kimi-k3 > DeepSeek V4 Pro > minimaxai/minimax-m3，并且越强通常越慢。这个排序仍是重要的运行经验和待验证假设，不冒充普适 benchmark 结论。2026-08-31 对当前 Kimi provider 的 `/models` 实际探针返回了 `deepseek-ai/deepseek-v4-pro-0813`，与 `kimi-k3`、`minimaxai/minimax-m3` 并列可用；因此该 ID 是当前 Kimi 路由的 DeepSeek V4 Pro 候选 ID。
7. **当前实现**：`selectionModels` 被解释为质量排序；默认 `selectionModelStrategy=quality-first`，autopilot 过滤当前 provider 可用目录后，把所有 N 个候选分配给排序中的第一个可用模型。`exploration` 是显式 opt-in，才按该排序轮换候选模型。每个候选仍有独立 child session、workspace、工具轨迹和策略指令。`z-ai/glm-5.2` 保留在 provider 注册表，但已移出默认候选池。
8. GLM-5.2 的运营约束必须单独建模：用户此前明确它是 OpenRouter 免费模型，每日约 1000 次，并有 provider 限流；历史实验还记录了单轮选择约 78--105 次请求的消耗。当前代码/配置没有为它建立独立 provider、baseURL、apiKeyEnv、daily quota、rate limit，也没有把这些约束接入候选调度或预算，因此不能宣称已经参考并执行了该限制。历史事实保存在 §7.3 和 docs/HANDOFF-HISTORY-2026-08-30.md，当前实现尚未落地。
9. 弱模型看起来变强必须单独举证：候选生成阶段不应共享强模型答案；verifier 只是在候选生成完成后读取所有候选来比较，ranking 不能证明弱模型本身被强模型提升，也不能证明异质搭配优于同一强模型多次独立尝试。

2026-08-31 的受控 live 对照已停止：`sel-5e84f540-97cd-44c0-8d9f-5ec6865da480` 的 objective check 命令被外层 PowerShell 转义破坏；`sel-bbc7de5a-dda1-4fd2-adba-02ca257d9796` 为 Kimi-only N=2/K=2，一名候选在 300000ms 超时，另一名产出目标文件但 check 未通过。两轮都没有进入 verifier ranking，因此不构成质量比较；没有启动异质 run，也没有触碰 GLM 配额。

**2026-09-03 状态更新**：上述 fixture/check harness 问题在后续轮次已被绕过——sel-a79f6c44 与 sel-52963163 都用独立 Git fixture（D:/tools/.autopilot-live-chain）跑通了候选编排，前者完成完整闭环（见 §0c 与 §6.2.1），后者首次到达多幸存者 ranking 但在 180s 预算内超时（见 §6.2.2）。因此“后续若要补质量实验”的下一步不再是修 harness，而是提高 ranking 预算并重跑多幸存者场景。至今仍未启动异质 run，仍未触碰 GLM 配额，仍无模型质量对比结论。

## 0b. 当前运行快照

| 项 | 2026-09-03 实测事实 |
|---|---|
| 权威 GUI | http://127.0.0.1:3080/；页面可读，console 为空，抽样 network 无失败 |
| 插件 | @dsh-external/dsh-verifier-autopilot 为 active/injected；client.js 存在 |
| HMR | client HMR receiver 存在，但没有 pnpm run dev:web watcher；client 源码修改后必须 build、reload 并刷新 GUI，不能承诺自动更新 |
| Git | branch=main；「强度旋钮全量可配且默认拉满；discard foreign-repo 修复；排名上限 600s」这笔已提交、工作树 clean；`git worktree list` 只列出主仓库 |
| selection 配置（当前 live，2026-09-10 回读） | selectionMode=**always**（持久层值；源码默认 auto）、modelStrategy=quality-first、provider=kimi、models=kimi-k3,moonshotai/kimi-k3,nvidia/nemotron-3-super-120b-a12b,nemotron-3-ultra-550b-a55b,minimaxai/minimax-m3,deepseek-ai/deepseek-v4-pro-0813、standard/deep N=2/3、K=1、P=**1**（持久层；源码默认 0）、effort=**max**（持久层；源码默认 low） |
| 时间预算 | autopilot/manual candidate 默认=600000ms（2026-09-10 抬界裁决，§6.4.4 第 7 条）；selection 默认=600000ms；selection 输入范围 30000..600000ms；lane timeoutMs=180000ms、maxTokens=64000 |
| live state | GET /state 与 /selections 最近核验 active=null、retainedWinners=[]；无在途 selection；插件 reload 后仍 active |
| sidecar | 当前无 llm_verifier_sidecar.py 进程；bridge 为 lazy、长驻、串行 JSONL，需要时再启动 |
| selection ledger | .data/selections.jsonl 保留历史 selection 记录；内存最多 200 条，API 列表最多返回最近 20 条 |
| legacy ledger | .data/records.jsonl：旧 verifier history 上限 500，4MiB 时压缩 |
| workspace root | .data/selection-workspaces 下的历史实验工件不自动删除；autopilot winner 由 source idle/detach/dispose 清理 |
| 临时 fixture | 真实 live selection 应使用新的独立 Git fixture；不要复用已交付的旧 source 仓库作为新任务 |
| Verifier 页设置 | settings commit 会同步 Host live config；当前持久层与 live state：enabled=true、autoFeedback=true、model=kimi-k3、baseURL=https://chat.holisthoom.top/v1、apiKeyEnv=KIMI_API_KEY、selectionMode=always、strategy=quality-first、verifierEffort=max、P=1、selectionCandidateTimeoutMs=600000（2026-09-10 起） |
| 当前结论 | 多幸存者 ranking 的历史手动闭环已存在；本次代码修复新增并验证了自动路径的关键可用性：selection 在后台启动，source turn 立即继续，winner 完成后追加 relay，source idle/detach/dispose 清理 winner。当前仍不把自动路径的真实 source 集成结果冒充已完成，需看最近 selection record 和 source 事件。 |

不要把“临时 fixture 已删除”写成“所有历史 workspace 已清空”。历史目录含旧实验工件，未经明确清理请求不要删除。

## 0c. 当前交付结论

当前代码已把 Best-of-N 从排名演示推进为真实候选编排：它会决定 N/K、创建隔离候选、先做客观淘汰、严格验证 ranking，再把有界证据交给原始 source agent。失败路径不会伪造 winner。

**已跑通一次的端到端 live 闭环（2026-09-01 03:03--03:21，2026-09-03 核对）**：sel-a79f6c44 在 autopilot standard N=2/K=2、双 kimi-k3 下，c1 幸存 -> finalizer relay 14019 字符 -> source agent 把 money.js/money.test.js/package.json 集成进 D:/tools/.autopilot-live-chain -> git commit 3003e9f -> `node --test` 8/8 pass、退出码 0 -> 向用户交付 -> winner workspace 被 source-idle cleanup 回收（目录已不存在）。这是本机第一次“插件 relay 之后，source agent 真的集成、测试、提交并交付”的可复核记录。

必须诚实保留的边界：

1. 该闭环的 winner 是 `single-candidate`（`nComparisons=0`、score=null）：c0 在 900s 候选预算内超时，c1 是唯一幸存者。它证明 finalizer 链路与 lifecycle，不证明 verifier ranking 能选出更优候选。
2. 紧随其后的 sel-52963163（同一会话、同一任务族）首次让两个候选都 finished，但 verifier ranking 撞上 180s 绝对预算（`rankingAttempts=1`、`verifier selection exceeded its absolute budget`）。~~多幸存者 ranking 仍然缺一条成功记录~~ **2026-09-05 已补**：sel-1b5c286c 完整走完 workspace→preflight→双候选真实 rollout→客观检查→verifier 锦标赛→discard 全链（详见 §6.2.2；此前同日 sel-cd6590de 为首次完成的 tournament，`sel-7fad98df`/`sel-ac011a39` 分别是"kimi-k3 死锁"与"300s 预算不够"的失败对照）。
3. 插件本身不审计 source turn；本条的“集成/测试/提交/交付”证据来自 09-03 的旁路核对：winner handoff 内可检索到交付文件的特征串（`must be a safe integer (amount in cents)`、`money.test.js`、`module.exports = { add, sub, format }`），fixture HEAD commit 3003e9f（03:21:43）落在 selection finishedAt（03:18:25）之后，且当前 fixture 工作树 clean、`node --test` 8/8、退出码 0。这是外部旁证，不是插件自动产生的证明；winner workspace 已被回收，因此无法做 handoff 与集成文件的哈希比对。

因此可宣称“端到端闭环跑通一次 + 实现与离线门禁完成”；2026-09-05 起还可加一条“多幸存者 verifier ranking 已在 live 完成（§6.2.2）”。但 pipeline 通的证据 ≠ 多模型区分度证据，弱模型是否被强模型系统性抬高仍未证——那是另一轮受控实验。

## 1. 实现地图

- src/selection/autopilot.ts：准入分类、standard/deep 策略、候选路由、上下文包、finalizer relay。
- src/selection/candidates.ts：worktree 后的候选编排、并行 rollout、checks、ranking、结果校验、winner/loser 生命周期。
- src/selection/host.ts：Host API、单在途准入、凭据、preflight、ledger、manual/autopilot lifecycle。
- src/selection/live.ts：Git source resolution、dirty snapshot、worktree lease、精确字节 overlay、会话存储清理。
- src/selection/bridge.ts：长驻 framed JSONL sidecar、timeout/abort、child 重启、密钥边界。
- src/selection/retry.ts：仅瞬时错误重试、绝对 deadline、caller abort、动态剩余 timeout。
- src/selection/trajectory.ts：去除 runtime/header/retry/injected-message 噪声，生成有界证据。
- src/selection/checks.ts：在候选 cwd 顺序执行 caller-supplied checks；shell 按平台链解析一次（pwsh → win32 的 powershell / 其他平台的 /bin/sh），结果记录 `shell` 字段。src/selection/proc.ts：live.ts 与 checks.ts 共用的有界子进程 runner（叶子模块）。
- src/config.ts：Schemastery 配置 schema、默认值、patch allowlist 与 settings source hooks。
- src/api.ts：HTTP/SSE transport、鉴权、限流与状态码映射。
- src/index.ts：legacy verifier、autopilot pre-step、API、GUI Host 的薄装配入口。
- src/client/index.ts：Verifier 与 Candidate selection 面板。
- bridge/llm_verifier_sidecar.py：上游 llm_verifier 的 select/progress/preflight 适配和 usage。
- bridge/PROTOCOL.md：sidecar wire contract。
- scripts/tests/*.test.mjs：离线回归按领域拆成 16 个文件（evidence / verifier-scoring / verifier-lanes / host / api / config / repair-v2 / bridge / selection-runner / selection-host / autopilot / workspaces / storage / process-checks / diagnostics / payload），共享夹具在 scripts/tests/helpers/；`npm test` = `node --test "scripts/tests/*.test.mjs"`，每个文件独立进程，可单独运行。sidecar 协议帧的唯一来源是 bridge/protocol-fixtures.json（self_test.py、stub sidecar、bridge 测试三方共用）。

## 2. 当前生产契约

### 2.1 Autopilot 准入与上下文

- 只在原始 agent 的 step=1 运行；parentSession、status-only、空任务、外部副作用任务和不满足 auto 阈值的消息直接跳过。
- 使用 downstream pre-step 已接受的直接 user text，不读取被拒绝或注入的原始 inbox；非文本 block 跳过；任务上限 32000 字符。
- source cwd 必须解析到唯一可用 Git repository。解析失败时回到 source agent，不猜 workspace。
- 上下文只取最多 8 条近期 USER/ASSISTANT 内容，每条有界；current task 标为最高权威，历史上下文标为非指令。
- autopilot 不复制 raw session seed，候选只接收 bounded context packet；manual /select 可继承最多 600 events 的完整 turn 边界 seed。
- selectionMode=auto 只接 actionable task；always 仍受安全和可执行边界约束。

### 2.2 Workspace 快照与隔离

- worktree 顺序准备，因为 Git worktree 锁不能并发；candidate agent 随后并行创建和运行。
- strict autopilot snapshot 先应用 git diff --binary，再用 live tracked bytes 覆盖，避免 core.autocrlf/filter 改变候选字节。
- tracked 变化最多 5000 文件、256MiB；untracked 最多 2000 文件、64MiB；ignored 枚举最多 2000 项。
- untracked symlink 和 special file 拒绝；tracked symlink 只允许解析到 source root 内；路径逃逸拒绝。
- 唯一允许静默省略的 ignored 生成/依赖路径是 node_modules/、lib/、.data/、eval/results/、*.tsbuildinfo、*.tgz；未知 ignored source/config 直接报 workspace-ignored-input-unsupported。
- manual diagnostic 可在非 Git 空 workspace 运行；不要把该宽松模式用于 autopilot。

### 2.3 Candidate、progress 和 checks

- candidateCount 最大 5；autopilot 始终至少 2，manual API 可显式 N=1。
- autopilot candidate timeout 默认 600000ms（2026-09-10 抬界裁决：300s 实测落在强候选真实工作区间中段，见 §6.4.4 第 7 条；commit 9927986）；直接 /select 未传值时跟随 Host 配置；输入范围 30000..1800000ms。
- candidate turn/end reason.kind=error 必须记 failed；timeout、agent-create、progress-abandoned 和 check 淘汰均保留原因。
- progressGuard 默认关闭；启用时使用 llm_verifier.track，只有连续低分且没有新 tool/result 才取消，默认 60s、minScore=0.15、grace=3、maxChecks=8。
- objective checks 最多 5 条、command 最长 2000 字符；顺序运行于进程内解析出的第一个可启动 shell（优先 `pwsh -NoProfile -Command`；没有 pwsh 时 win32 退到 `powershell`，其他平台退到 `/bin/sh -c`），默认 60s，记录 stdout+stderr 尾部 2000 字符与实际 shell 名。命令写成哪种方言由部署机决定——跨平台部署请用两种 shell 都能跑的命令（如 `npm test`）。
- 整条链都启动不了、或 shell 启动失败（ENOENT）时是 harness error（`harnessError:true`，尾部以 `harness:` 开头）：候选保留并标 `checksInvalid`，与 B-10 的"解析错误不淘汰"同一路径。
- checks 没有命令 allowlist，也不是 DSH fs sandbox。timeout 只 kill shell 进程，孙进程可能存活（runner 会在 exit 后最多等 1s flush 再放弃管道）；命令必须自包含且只作用于候选 workspace。
- **checks 门禁可反噬**：若 check 的失败输出是 shell 解释器级错误（`is not recognized as`、ParserError 等），判 `checksInvalid=true`，候选不因此淘汰、该 check 视为缺省（rerun 时同指纹 check 全失败即属此类）；record 以 `checksUnreliable` 明示。

### 2.4 Preflight、ranking、margin gate 与重试

- 多幸存者必须有真实 ranking 且 verifier 结果经过严格校验：winner index、有限 0..1 scores、完整唯一 ranking permutation、分数降序、index tie-break、winner/ranking 一致性、nComparisons>0；任何一项失败 fail-closed。
- preflight 在 worktree 准备后、candidate agent 创建前运行；用一组明显非对称 pair 检查真实比较数和严格顺序，并按 baseURL/model/apiKeyEnv 在当前 Host 生命周期 memoize。
- preflight 与 ranking 使用相同的归一化 timeout 值，但各自创建独立绝对 deadline；不是从 preflight 开始共享一个跨阶段总 deadline。因此最坏总墙钟还包括 workspace、preflight、candidate 和 ranking 各阶段。
- selection timeout 默认 600000ms，归一化范围 30000..600000ms（2026-09-05 从 300s 上限抬升至 600s：effort=max 下单次 minimax-m3 比较 70..100s，最小锦标赛已逼近 300s；host normalize、runner budget、autopilot clamp 三处同步）。preflight 和 ranking 各自最多 2 次 attempt，只重试 retriable BridgeError，backoff 和 attempt 共用该阶段 deadline。
- Kimi verifier maxWorkers=1，避免并发撞 relay pending/concurrency 限制；候选 rollout 仍可并行。
- 当前自动运行默认是可用优先的标准档 N=2/K=1/P=0，deep 为 N=3 且 K 至少 2；verifier 思考强度为 low。N/K/P/effort 可在 GUI 或配置中提高；bridge 的 n_evaluations=4 只是直接调用未传值时的上游兼容 fallback；P 缺省时（极少路径）fallback 为 1。
- 思考强度（verifierEffort，off/low/high/max）同时作用于两条 verifier 路径：五路 lane 在 chat body 里附带 thinking/reasoning_effort 字段（off 显式 thinking:disabled）；selection 侧的 effort 字段经 bridge frame 直达 sidecar，由其在请求作用域内设置 DEEPSEEK_EFFORT（调用结束后还原，不会污染 health 或下一个请求）。preflight 的 memoize tuple 包含 effort，切换强度会重新预检。
- 多幸存者必须过三道门才可能成为 winner（2026-09-08 起）：(1) has-work —— code/file 型任务要求候选有执行类工具调用（`tool_search`/`tool_slimmer_catalog`/`tool_call` 等元工具不计）或非空 worktree diff，否则记 `insufficient-evidence` 淘汰；全灭则 `outcome=insufficient_evidence`，不 relay winner。(2) noSearchSpace —— 幸存候选 git diff 指纹全等时去重为 single_candidate_fallback，绝不花 verifier 配额（R2 起：指纹按文件内容哈希；按指纹分组只留最小编号，部分重复也去重，记 `dedupedCandidates`；空 diff 不去重；只读工具 read/grep/ls 等不计 has-work）。(3) margin gate —— verifier 返回通过严格校验后，top-2 margin < `selectionMarginThreshold`（当前 **0.03**，首轮 C0 校准噪声上限 2.2×，仍标 provisional；record 留存 `margin/marginThreshold/marginCondition/marginProvisional`）或完全平分时 `outcome=abstain`，不设 winner、不写 winnerBasis。
- **ranking 输入可靠性（2026-09-08 补强）**：每个幸存者轨迹前会前置 `[DETERMINISTIC EVIDENCE]` 块（taskKind、执行类调用数、diff 统计、checks 逐条 exit 码、harness-error 标注），ranker 不再只依赖 24000 字符截断后的轨迹尾部。
- **模型探活（2026-09-08 起）**：`selectionProbeEnabled` 默认开；autopilot 在规划前按 (baseURL,key) 对每个 preferred∩catalog 候选做 1-token 探活，死模型（kimi-k3 式窗口）从当次候选池剔除；结果按模型缓存、死模型 120 秒 cool-down 后复探；policy.probes 落进 ledger。
- **source 后置审计增强**：交付判定改走 `evaluateDelivery()`；新增可选配置 `selectionPostAuditTestCommand`——仅当显式配置时 cleanup 会在 source cwd 跑一次测试命令（120s 上限），全部满足（HEAD 前进/有改动 + 测试退出码 0）才记 `delivered=yes`；缺省/未配置只记 `unknown`/`no`。record 另带 `timing.{relayedAt,auditedAt}` 供 B-9 判读回放。
- **`outcome` 状态机六值**（每个 settled record 恰一）：`ranked_winner` / `objective_only_result`（历史值：R2 2.3 证明不可达，已不再产生，只为旧 ledger 保留）/ `single_candidate_fallback`（唯一幸存者，未比较，relay 明示）/ `insufficient_evidence` / `abstain` / `verifier_unavailable`（基础设施故障且全员 checks 通过——不再整条 `failed`；`error`/`note` 保留原因字段）。`winnerBasis` 收窄兼容：`verifier` 仅与 `ranked_winner` 同时出现。读 ledger 的消费者必须先读 `outcome`。
- preflight 在 worktree 准备后、candidate agent 创建前运行；用一组明显非对称 pair 检查真实比较数和严格顺序，并按 baseURL/model/apiKeyEnv 在当前 Host 生命周期 memoize。
- preflight 与 ranking 使用相同的归一化 timeout 值，但各自创建独立绝对 deadline；不是从 preflight 开始共享一个跨阶段总 deadline。因此最坏总墙钟还包括 workspace、preflight、candidate 和 ranking 各阶段。
- selection timeout 默认 600000ms，归一化范围 30000..600000ms（2026-09-05 自 300s 上限抬升；2026-09-08 起 manual /select 省略 selectTimeoutMs 时跟随 config，不再回落硬编码 180s）。preflight 和 ranking 各自最多 2 次 attempt，只重试 retriable BridgeError，backoff 和 attempt 共用该阶段 deadline。
- Kimi verifier maxWorkers=1，避免并发撞 relay pending/concurrency 限制；候选 rollout 仍可并行。
- 当前自动运行默认是可用优先的标准档 N=2/K=1/P=0，deep 为 N=3 且 K 至少 2；verifier 思考强度为 low。N/K/P/effort 可在 GUI 或配置中提高；bridge 的 n_evaluations=4 只是直接调用未传值时的上游兼容 fallback；P 缺省时（极少路径）fallback 为 1。
- 思考强度（verifierEffort，off/low/high/max）同时作用于两条 verifier 路径：五路 lane 在 chat body 里附带 thinking/reasoning_effort 字段（off 显式 thinking:disabled）；selection 侧的 effort 字段经 bridge frame 直达 sidecar，由其在请求作用域内设置 DEEPSEEK_EFFORT（调用结束后还原，不会污染 health 或下一个请求）。preflight 的 memoize tuple 包含 effort，切换强度会重新预检。
- 单幸存者只可标 objective-check-only 或 single-candidate（`outcome=single_candidate_fallback`），score 为 null，不能冒充 verifier winner。
- 任务类型在准入阶段由确定性分类器定（`classifyTaskKind`），写入 policy.taskKind；「已收口/全部通过/汇总如下」类完成汇报直接拒收（K.4-7，sel-1c8d28ef 教训），候选/LLM 不自报类型。analysis-text 任务不做 has-work 淘汰，全程 `llmOnly=true`，永不 verified。
- ranking score 是候选池内相对强度，不是校准概率；`margin` 同在 record 里。verifier 不可用时若全员 checks 通过则 `verifier_unavailable`（不 retain），否则整轮 `failed`——基础设施故障不是裁决（R2 2.6 确认此语义）。

### 2.5 Finalizer 与 lifecycle

- buildAutopilotRelay 最多携带两个 finalist 的有界轨迹摘录，并明确要求 source agent 检查 winner workspace、保护用户编辑、集成、测试和交付。
- 该 finalizer contract 是 prompt-level contract，不是插件自动 merge/test enforcement；当前没有后置审计器证明 source turn 已履约。
- runner 保留 winner、回收 loser。manual winner 的 live handle 在 finishRun 立即 dispose，但 session/workspace 保留；generic [Selection 结算] notice 只用于非-autopilot。
- autopilot pre-step 只同步完成准入和 selection start，随后立即返回原始 source decision；后台 waiter 在 winner 完成后追加 relay。autopilot winner handle 在 relay 后暂时保留，source agent idle、detach 或插件 dispose 时自动 discard session/workspace；autopilot 不发送 generic settlement notice。source abort/detach 会取消在途 selection，但不会等待慢 provider 的完整结算。
- /selections/release 只释放 live handle并保留 session/workspace；没有 handle 时返回 not-retained。它不是“幂等删除”。
- /selections/discard 删除可丢弃 winner 的 handle、workspace 和 session store，并追加 discardedAt；重复 discard 返回 no-discardable-winner。
- **2026-09-05 修复**：候选工作区若位于"宿主外壳 git 仓库"内部（本插件托管 `D:/tools/dsh-plugins/dsh-verifier-autopilot` 自带 .git），`git rev-parse --show-toplevel` 会把普通候选目录冒名成外层仓库 worktree，discoverLease 以 workspace-path-outside-managed-root 炸开整个 remove()/discard 路径。现为：toplevel 落在管理根之外即认定"非 worktree"，按普通目录 rm；回归测试为 `workspace manager: a foreign git repo above the managed root must not hijack lease discovery`。
- **2026-09-08 起 relay 按 outcome 区分文案**：ranked_winner 才带原 finalizer 契约；single_candidate_fallback 明示「未经候选间比较」；objective_only_result 明示「仅客观检查排序」；abstain/insufficient_evidence/verifier_unavailable 不附 finalizer 契约、double-finalist 等同权证据或明确叫停。想冒充选优的措辞不存在了。
- **审计包**：`finishRun` 与 `discardWinner` 都在清理工作区**之前**把 `.data/selection-artifacts/{selectionId}.json` 落盘（race：先写盘后回收）。内含起跑有效配置快照（含 candidateOptions 实际值、verifier/model/effort/baseURL host、taskKind、checks 名）、sourceModel、sourceHeadAtStart、margin/threshold/condition、outcome/winnerBasis、noSearchSpace/llmOnly/checksUnreliable 标志、finalists 摘录；discard 时重写以追加 discardedAt 与 delivery。manual 与历史 record 无此包，但保留历史文件字段兼容。
- **审计包 v2（2026-09-10，G/F6 补齐）**：一个 `SelectionRunResult.artifacts` 在 runner 内部于 loser dispose **之前**捕获；落为目录 `.data/selection-artifacts/{id}/`：`record.json` + `traces/c{i}.txt`（候选渲染轨迹全文）+ `diffs/c{i}.patch`（`git add -N . && git diff HEAD` 的全量 patch、含 untracked 清单、256KB 截断标记；intent-to-add 写在临时 `GIT_INDEX_FILE` 副本里，候选真实 index 不被改动）。同一条写旧的 `{id}.json` 平面文件已废弃；`writeArtifact` 的 settle-vs-discard 两阶段不变。
- **source 后置审计（G-4）**：autopilot winner/fallback 在 source idle/detach/dispose 前的 cleanupAutopilotWinners 里做 HEAD-before/after + 工作区脏读数，写入 `delivery`，`delivered` 三值：观察到集成证据但测试未运行 → `unknown`；审计执行且无变化 → `no`；未执行 → `unknown`。插件不擅自跑用户的测试。
- **存储生命周期（2026-09-23 起）**：审计包与 ledger 窗口同寿——`SelectionHost.collectArtifacts()` 在成功加载 ledger 后、以及新 run 挤出旧记录时，删除 `.data/selection-artifacts/` 下 id 不在窗口（最新 `SELECTIONS_HISTORY_LIMIT`=200 条）内的目录与旧版平面 `{id}.json`；ledger 读不到/为空则一律不删；目录里非 `sel-*` 形状的条目不碰。候选目录孤儿由 `reclaimOrphanWorkspaces()` 在 Host start 后台处理：有记录且非保留 winner/fallback（`discardedAt` 未设）且非进行中 → 回收并清 session store；**无记录的目录只报 `workspaces.unknown`，绝不删**（可能是 aged-out 的手动 winner）。running 占位行现在在 start() 时就落 ledger，进程中途死亡后重载得到 `interrupted-by-reload` 而非空洞。manual winner 的保留/丢弃仍由操作员决定，autopilot 仍走 source-idle cleanup——GC 只清"再也没人能引用"的东西，不把两者写成统一生命周期。

## 3. Host API、ledger 与 GUI

API prefix：/@dsh-external/dsh-verifier-autopilot/api

- GET /state：当前 config、legacy records 和 selection snapshot。
- POST /config：更新 allowlisted config。
- POST /select：manual diagnostic 入口，202 Accepted；autopilot 另由 pre-step 内部调用同一 SelectionHost。
- GET /selections：按 selectionId 查询或列最近 20 条；同时返回 active 和 retainedWinners。
- POST /selections/cancel：中止当前 selection。
- POST /selections/release：释放 live winner handle；保留工件。
- POST /selections/discard：删除 winner 工件与 session store。
- POST /verify、/probe、/eval 及 GET /records：legacy verifier 路径，仍共存但不是 candidate ranking。
- GET /events：SSE state stream。

安全与额度：

- 设置 DSH_VA_API_TOKEN 后，provider-spending 和 mutating POST 必须带 Authorization: Bearer <token>；只读视图保持本机可读。
- /select 为滑动窗口 12/hour；只有 Host 真正 admitted 的 start 才 commit，busy/bad route/missing key 不耗额度。
- /eval 120/min、/probe 60/min、/verify 60/min。
- selection terminal record append JSONL；discard 再追加同 selectionId 的更新，加载时保留最后一条。运行中的 onUpdate 只 emit、不逐次持久化；running-on-reload 归一为 interrupted-by-reload；200 条/4MiB 有界。
- legacy records 与 selections 是不同 ledger，不能把 legacy fixture 指标当作 Best-of-N winner 证据。
- GUI 有 Verifier 与 Candidate selection 两个 tab；显示 policy、candidate status、winner basis、cancel/discard。Verifier 面板可直接改 轮数(routes)/思考强度(verifierEffort)/输出上限(maxTokens)/验证模型；候选控制面板可直接改 模式、质量策略、普通/深档 N、评估轮数 K、枢轴迭代 P、思考强度、provider、模型池。autopilot winner 不向 operator 暴露 manual cleanup 按钮，因为 source-idle cleanup owns it。

## 4. 默认值、预算与 provider 约束

| 配置/路径 | 当前值 |
|---|---|
| baseURL / model / apiKeyEnv | https://chat.holisthoom.top/v1 / nvidia/nemotron-3-super-120b-a12b（源码默认）／moonshotai/kimi-k3（2026-09-16 持久层+live 实测，operator 自选） / KIMI_API_KEY |
| selectionMode | 源码默认 auto；当前持久层 always |
| selectionProvider | kimi |
| selectionModelStrategy | quality-first（默认）；exploration 显式 opt-in |
| selectionModels | nvidia/nemotron-3-super-120b-a12b（源码默认；质量顺序完全由 operator 编辑，不在 provider `/models` 中的自定义 ID 也会直接探活）／当前持久层+live 实测：moonshotai/kimi-k3（单点，2026-09-16） |
| standard / deep candidates | 2 / 3，配置范围均为 2..5 |
| selectionEvaluations（K，评估轮数） | 1，范围 1..8；deep 至少 2 |
| selectionPivots（P，枢轴迭代数，O(N·P)） | 源码默认 0；当前持久层 0（2026-09-16 实测，已由 09-10 的 1 改回）；范围 0..5，按幸存者数收敛 |
| verifierEffort（思考强度，lane + tournament 共享） | 源码默认 low；当前持久层 max；off/low/high/max |
| verifierMinIntervalMs（发送平滑） | 0=关（源码默认）；令牌桶间隔 ms，lanes 与锦标赛 sidecar 共享，防突发打满限额 |
| verifierSmallModel（分层小模型） | ''=关（源码默认）；会话验证机械 lane（completion/evidence）改用小模型（如 nvidia/nemotron-3-ultra-550b-a55b），难 lane 与锦标赛仍用主模型 |
| lane timeoutMs / maxTokens | 180000ms / 8192（已拉满；思考从输出预算中扣除） |
| autopilot candidate timeout | 600000ms，范围 30000..1800000 |
| manual omitted candidate timeout | 跟随 config.selectionCandidateTimeoutMs（默认 600000ms）；仅当 Host 未接线时才回落到 runner 600000ms 防御值 |
| manual omitted K / P | 跟随 config.selectionEvaluations / selectionPivots（Host 级默认值接线） |
| selection timeout | 600000ms，范围 30000..600000（2026-09-05 自 300s 抬升） |
| verifier workers | 配置化：selectionVerifierWorkers（0=auto 4；1..16 显式，99 钳 16）。中转站按请求轮询分号，并发请求摊到不同账号；调用数恒等式不变，只改墙钟时间 |
| retry | maxAttempts=2，阶段绝对 deadline，abort-aware backoff |
| selection workspace | .data/selection-workspaces |
| selection ledger | .data/selections.jsonl |
| legacy ledger | .data/records.jsonl |
| Python | `DSH_VA_PYTHON` 优先；未设置时若 D:/tools/pyvenvs/llm-verifier-bridge/Scripts/python.exe 存在则用它，否则回退 PATH 上的 `python`（win32）/`python3` |

provider 注意事项：candidateOptions 必须能补成完整 provider+model；半路由或未知模型 fail-fast（catalog 不再是 allowlist——2026-09-13/16 改造后 `availableModels = preferred ∪ catalog`，不在 `/models` 里的 operator 自定义 ID 也会被直接探活，由探活决定去留）。selectionModels 是按质量排序的优先列表。quality-first 会把全部 N 个候选压到探活后的第一名可用模型；exploration 才会轮换已有模型。因此 standard N=2 出现两个同模型候选是默认行为，不是记录错误。

## 5. 构建、测试与环境

### 5.1 当前环境

- 工作目录：D:/tools。DSH_WEB_URL=http://127.0.0.1:3080，DSH_HOME=C:/Users/Admin/.dsh。
- DSH_CHECKOUT 当前未设置。DSH 安装根：C:/Users/Admin/AppData/Local/hermes/node/node_modules/@deepseek-ai/dsh。
- build.sh 首选有 packages/ 的 source checkout；当前走 installed-runtime fallback。
- fallback 依赖：DSH_RUNTIME_DEPS 默认 D:/tools/dsh-plugins/dsh-plugin-playwright-0.2.0；DSH_TYPESCRIPT_ROOT 与 DSH_ESBUILD_ROOT 默认 D:/tools/dsh-plugins/dsh-thread-0.1.3；DSH_INSTALL_ROOT 和 DSH_ESBUILD_PATH 可覆盖。
- bridge venv：Python 3.12.13，openai 3.3.1。显式 system Python 同为 3.12.13，但没有 openai，不能直接替代 bridge venv。
- 参考目录 D:/tools/llm-as-a-verifier-main 存在但没有 .git；它是本机参考树，不是当前 working repository。
- package private=true；没有 commit；不要把 working tree 当作已发布版本。
- client HMR receiver active，但无 pnpm run dev:web watcher；源文件修改不会自行重建 client bundle。

### 5.2 可复现门禁

按顺序运行：

~~~text
bash scripts/build.sh
npm test
DSH_VA_REQUIRE_LLM_VERIFIER=1 D:/tools/pyvenvs/llm-verifier-bridge/Scripts/python.exe bridge/self_test.py
git diff --check
~~~

- npm test 从 lib 导入，必须先 build。npm run eval 也不会自动 build，且旧 runner 主要覆盖 legacy /api/eval。
- npm run typecheck 在当前 shell 曾因 PATH 中没有 tsc 失败；build.sh 已通过显式 TypeScript 路径执行 tsc。不要把 PATH 失败写成类型错误，也不要把它写成独立 typecheck 已通过。
- 本轮最终重跑（2026-09-03，工作树 = HEAD 5d0d149 + 4 个未提交文件）：bash scripts/build.sh 输出 build: complete；npm test 为 167/167、0 fail；bridge self_test.py 全部 PASS（health/bad_frame/empty_candidates/single_candidate/missing_api_key/shutdown/progress_frame_validation/mojibake_expectation）；git diff --check 通过（退出码 0）。
- 2026-09-05 强度旋钮改造后：build: complete；npm test 173/173；self_test 9/9（新增 effort_scoping 门：非法 level→invalid_request、单候选 effort=max 通过、health 观察到进程 env 未被请求污染）；`dev_reload_package` 两次热重载均成功；live lane 探针在 effort=max 下 70.7s 严格打分通过；live manual selection（minimax-m3）多幸存者排名首次完成。git diff --check 通过。
- 2026-09-01 那轮同様为 167/167，但当时未跑 bridge self-test；09-03 补齐。
- dev_reload_package 热重载成功：清缓存 11 模块、重建 1 fiber，client ✓，before/after 均 active。
- Verifier 页 live 验证：模型切换会同步模型/端点/密钥环境，自动验证与低分复查开关会同步 Host；测试后已恢复用户配置。
- 权威 GUI 只能验证现有 http://127.0.0.1:3080/；不要启动替代 server。1440x900 与 390x844 刷新后 accessibility snapshot 均为非空完整 shell，包含导航、会话内容、Verifier 与候选控制 tabs；两种视口 console 为空、抽样 network 无失败。
- 本轮未完成像素级截图分析：当前 gpt-5.6-sol 不接受原生 image input，describe-image 又因其自身 baseURL 配置错误拒绝调用。保留截图不等于已做视觉像素验收；不要把 accessibility/console/network 结果夸大为像素级无布局问题。

## 6. 当前 live 证据和限制

### 6.1 最近 timeout/429 均不是 GPT ranking

| selection | verifier | candidate policy models | 结果 | 版本口径 |
|---|---|---|---|---|
| sel-4e8e214c-8e3d-42a8-9ec9-e096c6f80c3e | kimi-k3 | kimi-k3,kimi-k3 | preflight absolute budget timeout；无 winner | 发生在 preflight budget 修正前 |
| sel-a4b01bb9-236a-4850-8293-82e0a32f84b2 | kimi-k3 | kimi-k3,minimaxai/minimax-m3 | sidecar exceeded 900000ms；rankingAttempts=4 | 旧 K=4/旧 retry/旧 timeout 版本，当前 selection 上限已是 600000ms、attempt 最多 2 |
| sel-2c9a0333-220e-4271-90bb-b5d9aeb4c927 | kimi-k3 | kimi-k3,minimaxai/minimax-m3 | 429 concurrency limit | 旧并发/retry 运行证据 |
| sel-d780d31c-7418-4718-990a-35359070ecfa | kimi-k3 | kimi-k3,glm-5.2,minimax-m3 | 429 too many pending requests | 旧 N=3/K=4 运行证据 |

当前 API 可见历史里 verifierModel 计数为 kimi-k3=18、nvidia/nemotron-3-super-120b-a12b=2、GPT=0。GPT 渠道故障可能影响 source/finalizer，会影响最终整合，但不能解释上述 ranking timeout。

### 6.2 已取得的闭环与仍然缺的证据

#### 6.2.1 已有：sel-a79f6c44 完整闭环（standard N=2/K=2，双 kimi-k3）

| 阶段 | 证据 |
|---|---|
| trigger | autopilot；sourceSession=session-c77cbc90；03:03:08 起，耗时 917s |
| 候选 | c0 `candidate-timeout` 淘汰（900s 预算内 2723 events / 10 tool calls）；c1 finished 幸存（1653 events / 7 tool calls） |
| winner | status=winner，`winnerBasis=single-candidate`，score=null，`nComparisons=0`，`ranking=[1]` —— 无 verifier 比较，不是 ranking 胜利 |
| relay | finalist handoff 14019 字符，含货币工具的任务原文与候选轨迹摘录 |
| source 集成 | D:/tools/.autopilot-live-chain 新增 money.js、money.test.js、package.json |
| 提交 | git commit 3003e9f「Add money.js (add/sub/format in cents) with node:test coverage」，时间 03:21:43，晚于 selection finishedAt 03:18:25 |
| 测试 | `node --test` 8/8 pass、退出码 0（2026-09-03 在 fixture 目录重跑确认；工作树 clean） |
| 交付 | 由 source agent 在本机完成；插件不参与 |
| cleanup | winner workspace `.data/selection-workspaces/sel-a79f6c44-...` 已被 source-idle cleanup 回收（2026-09-03 确认目录不存在） |

旁路核对方式：handoff 内可检索到交付文件特征串；fixture HEAD 时间晚于 selection 结束时间；fixture 当前测试通过。winner workspace 已删除，无法做 handoff 与集成文件的哈希比对，因此这是强旁证而非字节级证明。

#### 6.2.2 已补录：多幸存者 genuine ranking 首胜（sel-cd6590de，2026-09-05）

- **sel-cd6590de-7d31-4ce1-a7dc-ffaa266f17f7**（manual、N=2、K=1、P=0、effort=max、verifier=minimaxai/minimax-m3、selectTimeoutMs=280s）：两个真实候选 rollout 全部 finished、preflight 过、**verifier 锦标赛完成**（`nComparisons=2`、`winnerBasis=verifier`、`ranking=[0,1]`、winner=c0、此后 /selections/discard 正常清场）。stage 序列 workspace→preflight→rollout→ranking→settled 全部走完。约 5.5 分钟。
- 注意判读边界：两个候选因继承本机 harness 会话的精简工具集（无写文件/shell 工具）都只产出解释性文本，scores 0.50000000469/0.49999999531 属"两者均未完成任务"的近平局 —— 本轮证明的是**管道完整性**，不是模型区分度。此前 sel-52963163 的多幸存者超时记录仍如旧文所述：当时 verifier=kimi-k3 且预算 180s。
- 同轮先行尝试 **sel-7fad98df**（同参数但 verifier=kimi-k3）以 `verifier selection exceeded its absolute budget` 失败（rankingAttempts=1）——kimi-k3 在 effort=max 下单次比较 70s+，N=2 锦标赛在 280s 预算内仍不达标；同一时刻换 minimax-m3 即成功。
- **完整成功链（sel-1b5c286c-1606-4fd0-976c-faf980668d7d，2026-09-05 深夜）**：manual、sourceSession=本会话、useSourceSeed=false、N=2/K=1/P=0、effort=max、verifier=minimax-m3、selectTimeout=560000ms（本轮把上限从 300s 抬到 600s 后的首个 e2e）：preflight 过 → 两候选真实完成（各 3 tool calls，`result.txt` 精确两行）→ 客观检查 result-file 双双通过 → 排名 2 次比较、scores 0.4934/0.5066、winner=c1、winnerBasis=verifier → /selections/discard 200 清场。中间还有 sel-ac011a39（同参数但预算 290s）再次证明 300s 上限在 max 强度下不够。
- **config.model 持久层**：settings.yaml 的 `dsh-verifier-autopilot.model` 已于本次修复时由 kimi-k3 改为 minimaxai/minimax-m3（此前 GUI 面板保存的 kimi-k3 在 reload 后会复活；POST /config 只是临时覆盖）。
- sel-290185b9-2211-4612-be1b-39804634b8d1 是旧 runtime 的 N=2 winner 记录，3 次比较、winner=c1，后来 discardedAt 已写入；它早于当前 timeout、strict ranking validation 和 finalizer relay，不能冒充当前版本证明。

#### 6.2.3 ledger 与磁盘对账（2026-09-04 复核）

- .data/selections.jsonl **36 行、87249 bytes、32 个唯一 selectionId**（较 09-03 快照 +2 行 /+2 id：sel-0d173ea4 与本会话手动探活 sel-c927132b）；重复行来自 append 更新语义（a79f6c44、f78b5d20、290185b9、4b1d0031 各 2 行），加载时保留最后一条。
- .data/selection-workspaces 17 个根、**12 非空 / 5 空**（较 09-03 快照非空少 2，属历史工件自然回收，未做人工清理）；a79f6c44 与 52963163 两个最新 root 均已不在，说明 source-idle cleanup 生效。
- live API（/state、/selections）active=null、retainedWinners=[]。

### 6.3 历史 workspace 现状

- .data/selection-workspaces 2026-09-04 实测 17 个 selection 根、**12 非空 / 5 空**；只有主仓库出现在 git worktree list，这些目录都不是注册 worktree。
- 两个最新 root（a79f6c44、52963163）已被 source-idle cleanup 回收，证明 autopilot 清理路径生效；其余仍含历史工件。active=null 和 retainedWinners=[] 不代表磁盘历史为零。
- 它们主要来自旧 manual/runtime lifecycle，保留为历史工件。不要在交接时无条件清空；若要清理，先按 ledger/winner/discardedAt 对照并单独确认。

### 6.4 2026-09-03 relay 实测：默认模型已不可用（最高优先级）

直连 `https://chat.holisthoom.top/v1`（KIMI_API_KEY，来自 C:/Users/Admin/.dsh/.credentials.yaml）的探测结果：

| 模型 | 结果 | 证据 |
|---|---|---|
| kimi-k3 | **0/7 成功** | 5 次 APITimeoutError（120s/181s/300s/76s/91s 各一），2 次 503 InternalServerError |
| moonshotai/kimi-k3 | 0/1 | 300s 超时 |
| deepseek-ai/deepseek-v4-pro-0813 | **0/3 成功** | 3 次全部 180--300s 超时 |
| minimaxai/minimax-m3 | **2/2 成功** | 2.7--3.1s；logprobs=True 返回 content_len=2、top_logprobs_alts=20 |
| nemotron-3-ultra-550b-a55b | **2/2 成功** | 40.6--89.7s；logprobs 同样返回 20 alts |
| nvidia/nemotron-3-super-120b-a12b | **2/2 成功** | 0.8--5.5s；tool_calls 正常 |
| step-3.7-flash | 0/2 | 503 |
| ox-alpha / ox-alpha-free | 0/2 | 503 |

关键结论：

1. **超时与 logprobs 参数无关**。A/B 对照：kimi-k3 与 deepseek-v4-pro 在 `logprobs=False` 和 `logprobs=True` 下都超时，是模型/路由本身不响应。
2. **logprob 打分路径在存活模型上是通的**：minimax-m3 与 nemotron-3-ultra 都返回 20 个候选 token 的 logprobs，正是上游 G=20 字母档打分所需要的形状。结论是「relay 与当前存活模型都返 logprobs」，只是**默认配置的那个模型挂了**。
3. **quality-first 会把故障放大成全量失败**：`autopilot.ts:110` 在 quality-first 下把 N 个候选全部压到 `usable[0]`；`usable` 由 preferredModels ∩ catalog 得出，而 catalog 来自 `ctx.llm.listModels()`（只列目录、不探活）。只要 kimi-k3 仍在目录里，N 个候选就全是 kimi-k3，全部超时。verifier 默认也是 kimi-k3，ranking 同样失败。
4. **当前 `selectionModels` 需要改**，否则 autopilot 不可用。建议顺序：`minimaxai/minimax-m3,nemotron-3-ultra-550b-a55b,nvidia/nemotron-3-super-120b-a12b`，并同步把 `model`（verifier）从 kimi-k3 换成 minimaxai/minimax-m3（3s 延迟对 180s ranking 预算最友好）。
5. 该故障窗口未知（可能是中转上游 NIM 侧的问题）。**恢复判定要重跑探活，不要只看 /models 目录**——`ctx.llm.listModels()` 只列目录不探活，kimi-k3 在整个故障期间仍出现在目录里。

**同会话内的 live 实证（不是推断）**：2026-09-03 23:37:25 触发的 `sel-0d173ea4-2ca0-4404-9386-d72f22328695`（autopilot、deep、N=3/K=3）中，`policy.models = [kimi-k3, kimi-k3, kimi-k3]`，3 个候选全部停在 `status=created`、**sessionId 全为 null**，64 秒后以 `verifier preflight: selection aborted during verifier retry` 结束，workspace 已被回收。这正是 quality-first 把 N 个名额全压到不可用 `usable[0]` 的直接后果。

**累计探活：kimi-k3 0/10、deepseek-v4-pro 0/6**（含 09-03 23:41 的 3+3 次复测）；minimax-m3 与 nemotron-3-ultra 保持 2/2。

#### 6.4.1 2026-09-04 复核：故障未恢复，且 live 配置已漂移

探活复测（09-04，直连 relay，`max_tokens=5`）：

| 模型 | 结果 |
|---|---|
| kimi-k3 | **FAIL** 45s 超时（累计 0/11） |
| deepseek-ai/deepseek-v4-pro-0813 | **FAIL** 45s 超时（累计 0/7） |
| minimaxai/minimax-m3 | OK 1.8--4.0s |
| nemotron-3-ultra-550b-a55b | OK 43.1s |
| nvidia/nemotron-3-super-120b-a12b | OK 0.66s |

**故障持续，不是抖动。** 同时发现 live 配置已相对本文档漂移（读 `GET /state` 为准）：

| 项 | 文档假设 | 09-04 live 实测 |
|---|---|---|
| `model`（verifier） | kimi-k3 | **minimaxai/minimax-m3**（当前默认） |
| `enabled` / `autoFeedback` | false / false | **true / false** |
| `selectionMode` | auto | **auto**（autopilot 已开启） |
| `selectionModelStrategy` | quality-first | quality-first（当前默认） |
| `selectionModels` | kimi-k3,... | M3 / NVIDIA / Nemotron 优先，旧慢模型后置 |

#### 6.4.2 2026-09-04 已执行的配置改动

按「救活 + 消除单点」执行，走 `POST /api/config`（`DSH_VA_API_TOKEN` 未设置，故无需 Bearer）：

| 项 | 改前 | 改后 |
|---|---|---|
| `selectionModels` | `kimi-k3,deepseek-ai/deepseek-v4-pro-0813,minimaxai/minimax-m3` | `minimaxai/minimax-m3,nemotron-3-ultra-550b-a55b,nvidia/nemotron-3-super-120b-a12b` |
| `selectionModelStrategy` | `quality-first` | **`exploration`** |
| `model`（verifier） | 已是 `minimaxai/minimax-m3` | 不变（无需改） |

**为什么必须同时切 `exploration`**（这是比换模型更关键的一点）：只换模型而保持 quality-first，等于把单点故障从 kimi-k3 **平移**到 minimax-m3，架构缺陷原样保留——下次 minimax 抖一下同样全灭。切到 exploration 后 `usable[index % usable.length]` 才真正用满 3 个模型，N=3 从同质变异质。

**已知副作用（记账，未修复）**：verifier 用 minimax-m3，而 minimax-m3 同时是候选之一，**self-preference 风险重新进入**。短期可接受（它是唯一快到能塞进 180s 预算的），但必须记账；若要消除，需把 verifier 换成不在候选池内的模型。

**持久化边界（重要，且已实测复现）**：`POST /config` 只改 live Host 内存态，**不写 `C:/Users/Admin/.dsh/settings.yaml`**（该文件的 dsh-verifier-autopilot 段只含 `baseURL/apiKeyEnv/model/enabled/autoFeedback/selectionMode` 六个 legacy 键，不含 `selectionModels`/`selectionModelStrategy`）。

**实测到的回退（不是推测，是本会话真实发生的）**：本次改动在会话中途**被自动还原**过一次——执行 `npm test`（其前置 `scripts/build.sh` 重建 `lib/`）触发了插件热重载，`installSettingsSection` 的 settings source 回调（`index.ts:114` `host.replaceConfig(current())`）把配置重置回 `apply()` 的 `defaults`（`src/index.ts:1308-1309`），实测回读确认 `selectionModels` 变回 `kimi-k3,...`、`selectionModelStrategy` 变回 `quality-first`。已重新下发修复。

因此，**任何 build / reload / 重启都会让本次改动失效**，而不只是进程重启。这也正好印证 §5.2「编辑本插件源码可能触发 Host reload」与 §7.4 的运维备注。若要长期固化，必须改 `src/index.ts:1308-1309` 的源码默认值并重新 build（属代码改动，未擅自动）。

**历史记录：`selectionMode=off` 的含义**：autopilot pre-step 准入已关闭，不会自动触发 selection。这解释了为什么 09-03 23:37 之后当时没有自然触发；当前 live 已是 `selectionMode=auto`，并已实际触发自动 selection。

**目录交集已验证（09-04）**：relay `/models` 返回 9 个模型（`kimi-k3`、`ox-alpha-free`、`moonshotai/kimi-k3`、`nvidia/nemotron-3-super-120b-a12b`、`ox-alpha`、`minimaxai/minimax-m3`、`nemotron-3-ultra-550b-a55b`、`step-3.7-flash`、`deepseek-ai/deepseek-v4-pro-0813`）。三个新配置的模型**全部在目录内**，因此 `usable` = 3，exploration 的 `usable[index % 3]` 在 N=3 时确实会落到 3 个不同模型（不会被静默塌缩成 1--2 个）。

注意 `autopilot.ts:103` 的 `usable = preferred ∩ catalog`：目录里**仍然包含已宕机的 kimi-k3 与 deepseek-v4-pro**（只列目录不探活）。只要它们不出现在 `selectionModels` 里就不会被选中，这正是本次改动的直接收益；但 §8 待办 2（探活/失败剔除）依然成立。

### 6.5 ledger 全量统计（31 条去重后；2026-09-04 复核通过）

> 口径说明：本表基于 09-04 早些时候的 **31 条**快照重算并复核。此后 ledger 增至 **32 条**（新增 sel-c927132b，为本会话手动探活且以 `all_candidates_eliminated` 失败），因此 §0b / §6.2.3 的最新计数比本表多 1 条。本表保留 31 条口径，以免与已逐条复核的直方图混算；需要最新计数请看 §0b。

| 指标 | 值 |
|---|---|
| 总行数 / 唯一 selectionId | 35 / 31 |
| status | completed=16、failed=10、aborted=5 |
| trigger | autopilot=10、manual=2、空（旧格式）=19 |
| winnerBasis | single-candidate=1，其余 30 条为空（旧格式未写该字段） |
| nComparisons | 0 × 8、3 × 3、5 × 5，共 8 条有过真实比较 |
| verifierModel | kimi-k3=25、nvidia/nemotron-3-super-120b-a12b=6 |
| verifier 请求数 usage.calls | 4,4,5,8,8,8,8,32（**峰值 32，不是历史记录的 78--105**） |
| cache_hit_rate | 全部为 0 |
| 分数极差 | 7/8 条 ≤ 0.026（几乎平分）；唯一明显分开的是 sel-4fcbc905（0.649/0.351，极差 0.2985） |
| candidate-timeout 候选 | 6 个，**工作区全部已回收**，files=0，无法验证“超时但已产出可用产物” |

**error 直方图**（31 条中 15 条带 error，与 non-completed=15 一致，分类求和已校验 = 15，无 UNCLASSIFIED）：

| 类别 | 条数 | 说明 |
|---|---|---|
| all_candidates_eliminated | 3 | 客观淘汰/超时把候选全部清空 |
| preflight_abort | 3 | preflight 阶段被 caller 中止（2 次 sidecar abort + 1 次 retry abort） |
| preflight_budget | 2 | preflight 撞绝对预算 |
| rate_429 | 2 | Concurrency limit exceeded / Too many pending requests |
| abort_after_candidates | 1 | 候选跑完后整体中止 |
| post_candidate_abort | 1 | 候选阶段后 sidecar 请求被 caller 中止 |
| preflight_tie_050 | 1 | 0.500/0.500 平分，preflight 的严格顺序门禁正确拒绝 |
| ranking_budget | 1 | ranking 撞绝对预算（即 sel-52963163） |
| sidecar_900s | 1 | sidecar 请求超过 900000ms（旧版本） |

合计 15。**verifier 侧故障（preflight_* 共 6 条）是最大单一来源，超过 429（2 条）**，说明限流早已不是主要失败原因；真正的失败集中在 preflight/ranking 的时间预算与中止路径。

#### 6.5.1 有真实 ranking 的 8 条记录（逐条复核，2026-09-04）

判定口径：多候选存活 + `nComparisons>0` + 存在 winner 对象。这 8 条是本机唯一的「BoN 到底有没有帮上忙」证据样本（均为 2026-08-27 至 08-30 的旧格式记录，winnerBasis 字段为空）。

| selection | nc | winner | scores | 极差 | usage.calls |
|---|---|---|---|---|---|
| sel-290185b9 | 3 | c1 | 0.4871 / 0.5129 | 0.0258 | 8 |
| sel-3699fb1c | 5 | c2 | 0.4978 / 0.5000 / 0.5016 | 0.0038 | 8 |
| sel-412c0c1d | 5 | c0 | 0.5006 / 0.5000 / 0.4992 | 0.0013 | 5 |
| sel-4fcbc905 | 3 | c0 | 0.6493 / 0.3507 | **0.2985** | 4 |
| sel-5fe0b270 | 5 | c1 | 0.5000 / 0.5022 / 0.4984 | 0.0038 | 8 |
| sel-8d778422 | 3 | c1 | 0.4956 / 0.5044 | 0.0088 | 4 |
| sel-9e4c14ea | 5 | c2 | 0.4967 / 0.5000 / 0.5044 | 0.0077 | 8 |
| sel-f78b5d20 | 5 | c2 | 0.4982 / 0.4977 / 0.5030 | 0.0053 | 32 |

**复核结论（比单纯「7/8 条近似平分」更重要的一点）**：这 8 条里 **7 条的 winner 工作区已被回收、候选轨迹不落盘**，因此无法事后验证「verifier 选中的赢家是否真的更好」。唯一还能做实质核对的是 sel-4fcbc905——它是 TSP 任务，存在 6 倍真实差距（k3 工件约 7957.8 vs Super 约 48785.3），verifier 给出 0.649/0.351 且方向正确。

也就是说：**8 条记录只能证明「差距足够大时 ranking 方向正确」，完全没有一条能提供「ranking 在微小差距下选对了更好候选」的证据**。这正是 §0a.2 第 9 条与 §9 停止条件要继续守住边界的原因。

> **2026-09-09 口径更新（margin gate = 0.03 后重读这 8 条）**：sel-4fcbc905（margin 0.2985）仍为唯一 ranked_winner；其余 7 条 replay 后全是 `abstain`（最大 margin 0.0258 也在门限内）。历史 `winnerBasis=verifier` ‑＞ 现在不再承载任何「选优」含义；ledger 写回的不是这些 record，只有新 record 用新口径。

## 7. 历史证据索引

旧版 §7b-§7i 原文完整保存在 docs/HANDOFF-HISTORY-2026-08-30.md；本节只给当前解释，避免历史数字被误当成现行验收。

### 7.1 Legacy stage4 与 repair-v2

- eval/results/stage4-report.json 是 legacy five-lane feedback 实验：6 个真实 session、快照时 8 个 verified turn；暴露 E 场景“任务约束泄漏导致 verifier 合理宽容但真实缺陷逃逸”和 F 场景 feedback quota race。它不是 candidate-selection winner 报告。
- eval/results/latest-run.log 的 4/4 defect detection 与 1/3 false positive 同样属于 legacy fixture；不能作为 Best-of-N acceptance。
- eval/experiments/repair-v2.preregistration.md 明确未运行：20 defect + 10 clean，预计 210、硬顶 300 provider 请求，每轮最多 12 steps/10min，不得向被试泄漏实验约束。不要为当前 selector 补跑，也不要把预注册预算写成已花费。

### 7.2 轨迹去噪与模型门禁

- 历史 journal 重放发现 request/header、context、title 和 retry 噪声挤掉真实 TOOL evidence；修复后 turn 1 traceChars 10088->1234，长 turn 的可见工具从 18/38 改为完整有界尾部 20/20。当前 trajectory 过滤继承该结论。
- 旧五模型门禁选择 kimi-k3 为默认；minimax-m3 标签纪律偶发；step-3.7-flash 长 prompt 超时；Super-120B 退役。GUI 的 deepseek-chat 等选项属于 legacy lane 配置，不等于 candidate pool 默认。
- NVIDIA relay structured_outputs/prefill 不可靠；selection 必须依赖真实 token-logprob/tag gate，缺失时失败，不能用 label fallback 伪装成功。

### 7.3 候选池与效果实验

- 旧 A/B/C 三任务的 9 个候选都通过外部 hidden battery，近平分约 ±0.005，只证明候选同质，不能证明 winner 更优。
- 异质池实验关闭了 candidateOptions 功能缺口，并发现 flash 零交付可被 checks 淘汰；这支持鲁棒性价值，但不是精细 ranking 价值证明。
- TSP 粗档实验 sel-4fcbc905：k3 工件约 7957.8、Super identity 约 48785.3，verifier 0.649/0.351，方向正确；glm 工件约 7947.7 但 candidate-timeout，未进入 ranking。它证明明显粗档可分，不证明 0.13% 微差模型优劣。
- K=4 细档复测：7954.4/8000.6/8056.3 的约 0.58% 档差排序不可靠，当前相对分数不能用于细微质量宣称；K=4 成本约为 K=1 的 4 倍，relay cached_input 历史上为 0。
- 本轮 Kimi-only live 记录：`sel-5e84f540-97cd-44c0-8d9f-5ec6865da480`（N=2/K=2）两候选都完成了部分工作，但 objective check 因外层 PowerShell 转义错误失效；`sel-bbc7de5a-dda1-4fd2-adba-02ca257d9796`（N=2/K=2）一候选 `candidate-timeout`，另一候选 check 失败但 workspace 中有正确 `result.txt`。两轮均 `all_candidates_eliminated`、无 verifier ranking/winner，不能作为质量比较。按用户要求未启动 GLM 或 heterogeneous exploration。
- 旧 hidden batteries 和重建脚手架位于仓库外 D:/tools/_trace-dump；该目录当前仍存在，但未被本插件 Git 版本化，也未纳入本轮门禁，因此不是权威 retained artifact。“7/7 winner 正确”只保留为当时实验记录，不升级为当前版本证明。

### 7.4 上游算法与运维教训

- 上游核心是 G=20 字母档 logprob 期望、K 次重复、criteria 分解和 PPT 相对排序；旧自查表报告 78.4% cache hit，但本 relay 历史 usage 为 0 cache hit。分数不是校准概率。
- sidecar request cache=null 只表示 wire 不接收持久 cache；sidecar 内使用 per-run temp cache，避免 ring/pivot 静默退化为 0.5，运行后删除。
- progressGuard 来自上游 ProgressTracker 思路，默认关闭。
- 旧运维曾清理 25 个 loser session ghost、约 2.2MB，并保留 14 个历史 winner；当前 15 个 workspace 根是之后/遗留磁盘事实，不应与当时数字硬拼成同一时点。
- 编辑本插件源码可能触发 Host reload 并中止 active selection。任何 live 复测前先完成源码修改和 build/reload，再开始 selection。

## 8. 下一会话接手步骤

1. 先读 §0a、§0b、§6，再看 git status；不要先跑 live selection。
2. 查询 dev_plugin_status、GET /state、GET /selections、job_list、git worktree list。若 active 非空，先等待或明确 cancel，期间不要改插件源码。
3. 修改后运行 §5.2 全部门禁；client 变更必须 build、dev_reload_package 并刷新现有 3080 GUI。没有 dev:web watcher时不要承诺 HMR。
4. 需要补当前 live 证据时，新建小型 Git fixture。**D:/tools/.autopilot-live-chain 已存在且被 sel-a79f6c44 用过（main，HEAD=3003e9f，工作树 clean）**：要复现闭环可复用它的仓库形态，但必须换一个新任务（旧任务已交付并提交，重跑只会产生重复的 commit）。已删除的 greeting fixture 不要复活。保留 Kimi verifier 可测试 GPT source/finalizer；若要测试 GPT ranking，必须显式更换 verifier model/baseURL/key，并在 record 中看到对应 verifierModel。
5. 一次有效 live closure 必须记录：source model、selection ID、policy N/K、candidate routes、objective checks、多幸存者 ranking、winnerBasis=verifier、source 集成 diff、测试输出、最终 source 答案和 idle cleanup。**下一轮的头号目标是把 sel-52963163 失败的那一步补上**：两个候选都 finished 时 ranking 撞 180s 预算，先把 `selectionSelectTimeoutMs` 提到 300000（配置上限）再重跑同一形态任务，并保留 ranking 阶段耗时。注意 sel-a79f6c44 的 winnerBasis 是 single-candidate，不能拿它冒充 ranking 胜利。
6. live 失败时记录 stage/error/attempt telemetry，恢复默认配置并清理新 fixture；不要用旧 winner 或 legacy report 填补当前证据。
7. 不启动替代 Web server；权威 GUI 始终是已有 http://127.0.0.1:3080/。

#### 6.4.3 历史验证尝试与当前补验证（2026-09-05）

审查意见对当时的时间点成立：截至 2026-09-04，配置改动只做了 live 回读，尚未跑出真实 selection。本节保留那次历史排查过程；2026-09-05 已按其建议打开自动路径并完成补验证，当前结论见下方“当前补验证”。

**已做的验证（全部通过，均为离线/静态证据）：**

| 验证项 | 方法 | 结果 |
|---|---|---|
| 门禁全绿 | `bash scripts/build.sh` → `npm test` → `bridge/self_test.py` → `git diff --check` | build complete；**167/167、0 fail**；sidecar 8 项全 PASS；diff --check 退出码 0。**副作用：这次 build 触发热重载，把 §6.4.2 的配置改动还原了（已重新下发），详见 §6.4.2 的持久化边界** |
| exploration 真的把 N=3 摊到 3 个模型 | 用真实 `planAutopilotTask` + 真实 9 模型目录 + 当前配置跑 | `["minimaxai/minimax-m3","nemotron-3-ultra-550b-a55b","nvidia/nemotron-3-super-120b-a12b"]`，distinct=**3** |
| 反证：quality-first 会塌缩 | 同上，仅换 strategy | `["minimaxai/minimax-m3", ×3]`，distinct=**1** —— 证实不切 exploration 就是平移单点故障 |
| 反证：旧配置的死法 | 旧 `selectionModels` + quality-first | `["kimi-k3","kimi-k3","kimi-k3"]`，全部死模型 —— 复现 sel-0d173ea4 |
| `selectionMode=off` 是否真挡住 autopilot | `planAutopilotTask(..., {mode:'off'})` | `admitted=false, reason='mode-off'` |
| 三个模型都在目录里 | relay `/models` | catalog=9，三个目标模型全部 IN CATALOG |

**为什么仍然跑不出一轮有效 selection（结构性原因，不是没试）：**

1. `selectionMode=off` → autopilot pre-step 在 `autopilot.ts:89` 直接返回 `mode-off`，**永远不会自动触发**。
2. 手动 `POST /select` 也救不了，两个独立原因：
   - **它不走 exploration 规划器**。`planAutopilotTask`（exploration 轮转的唯一实现）只在 autopilot pre-step 里被调用（`index.ts:695,705`）；手动 `/select` 走 `host.ts:439` 的 `start()`，只认请求体里的 `candidateOptions`。实测手动跑出来的记录 `policy=null`、`agentOptions.model` 为空 —— 即使用的是会话默认路由，**验证不到本次改动**。
   - **它拿不到 Git 工作区**。`sourceCwd` 只来自 `runtime.sourceCwd`（autopilot 内部路径）或 `parent.session.header.cwd`（`host.ts:450`）。不带 `sourceSessionId` 时 `sourceCwd` 为 undefined，三个候选全部 `workspace-prepare: source-workspace-not-git`。实测手动探活 `sel-c927132b` 正是以此失败（`all_candidates_eliminated`）。
3. 要让手动 `/select` 跑通，需要一个 **cwd 指向 Git 仓库的活 source session**，而 agent 会话只能由宿主创建，不能从工具侧凭空造出来。

**历史结论（截至 2026-09-04）**：本次改动当时仅在规划层被证明正确，端到端运行层尚未验证；该历史缺口已由下方 2026-09-05 的当前补验证填补。原先的二选一方案保留如下，供复现历史排查：

- **A（推荐）**：把 `selectionMode` 打开（`auto` 或 `always`），让 autopilot 自然触发，再观察 `policy.models` 是否为 3 个不同模型；或
- **B**：在 cwd 为 Git 仓库的会话里手动 `POST /select` 并显式传 `candidateOptions`（此时可验证候选与 ranking，但**测不到 exploration 轮转逻辑本身**，因为轮转在 autopilot 路径里）。

**注意 A 的代价**：打开 autopilot 会让它对后续每个合格的用户任务真实消耗 provider 额度并发起候选 rollout。

#### 6.4.4 待办（更新版 2026-09-08）

1. ~~跑一轮有效 selection 验证改动~~（2026-09-05/08 已完成：multi-survivor ranking 于 sel-1b5c286c；当前要补的是 §8 第 5 条的「实质代码任务」自动闭环）。
2. ~~把改动固化进源码默认值~~（2026-09-08 已合入 apply() 默认，settings.yaml 六键外的字段由源码承载）。
3. ~~margin gate 临时阈值上线~~（已完成：0.08 先上；**2026-09-08 校准首轮后降至 0.03**）。~~下一步：两轮 q95 差 <20% 后毕业~~ —— **2026-09-10 诊断否掉原准则**：n=40–60 下 q95 是尾部 1–3 阶次序统计量，四轮 q95=0.01023/0.00130/0.00535/… 的跨轮摆动（相对差 87%/311%）是估计器噪声而非噪声本体移动。毕业改走 **max-with-margin 条件单** `docs/MARGIN-GRADUATION-INVOICE.md`：同条件 C0 累计 ≥300 帧、≥3 轮/≥2 天、每轮 C0 max ≤0.02、C1 12/12、C2 ≥11/12、位置偏置 ≤0.005。round5（kimi-k3@low，C0×100 帧 + C1/C2 各 12）**已完成**：124 calls/0 failures，C0 n=100 max=0.01120、q95=0.0085（跨轮 +59%——n 翻 2.5 倍仍不进 20%，诊断坐实）、bias=0.00036，C1/C2 均 12/12；callsTotal=200 与调度恒等式逐帧吻合。marginProvisional 继续 true：条件单剩余 C0 60 帧 + ≥1 个不同自然日的复核轮（升级护栏：任何一轮 C0 max >0.015 → 重估阈值而非毕业）。改写期间的保守性不变：五轮两个模型家族的 C0 max 恒 ≤0.014，0.03 保持 ≥2.2x 裕度。
4. **完整 live 闭环收尾（G-4/delivered）**： relay 到达 → source 真集成 →（可配置的）测试退出码 → `delivered=yes` 自动路径 live 证据；delivered 机制已实现（evaluateDelivery + `selectionPostAuditTestCommand` 开关），缺一次真实跑通。
5. ~~模型探活收口~~（2026-09-08 已做：`selectionProbeEnabled` + cooldown + policy.probes 落盘；listModels 只列目录的风险被前排拦截）。
6. **GLM 配额模型另行讨论**：若启用，需独立 provider 槽位与每日配额记账。
7. ~~candidate-timeout 300s 撞线~~（2026-09-10 裁决=**抬界**：默认 300000→600000ms，源码三处默认 + ~/.dsh/settings.yaml 持久层同步，commit 9927986，重启/reload 后均生效。依据：sel-ac04cfd7 同款任务一个候选 <300s 完成、另一个撞线——300s 恰落在强候选真实工作区间中段；用户既定口径为质量第一、允许夜间长跑。不抬 900s+：sel-a79f6c44 c0 在 900s 预算下仍未收敛，病态循环归 progressGuard 管，不是预算大小问题。）
8. ~~llm_verifier 调度 calls/nComparisons 不规律~~（2026-09-10 定档 `docs/VERIFIER-SCHEDULER.md`：恒等式 `calls = nComparisons × criteriaCount × K`，上游无内部重试；旧记录 1.33–6.4x 属 policy/criteria 未落盘时代，不可复原、不再挖；新 record 增加 criteriaCount/expectedVerifierCalls 遥测，commit 32a67ed，往后任何比率偏差当场可见。）

9. **pi-ai stream idle timeout 300s 对中转卡死型故障太长**（2026-09-16 上午实证 69 次：每次挂满 5 分钟才被掐、重试才换号；与 operator 的 dsh-llm-retry maxRetries=2000 叠加，最坏情况表现为「卡住几小时」）：建议 pi-ai 层把空闲超时降到 60–90s（operator 侧配置，插件不动），并把重试次数回落到个位数——「快重试换号」才是号池语义的正解，不是加大次数。stream-guard（0.2.1）已覆盖 clean-stop 截断类；非断点字符截断与工具调用后的中断仍是已知不覆盖边界，观察待续。

（§8.1 的早期版本已并入本节，避免两份待办冲突。）

## 9. 停止条件

- 缺 logprob/tag 证据就失败，不用 0.5 或 label-only 填空。
- 多幸存者没有真实 ranking 就不选 winner。
- 候选没有客观差异就不声称质量提升；相对分数不当概率。
- winner 不能映射真实 child session/workspace 就不称 winner。
- verifier 不可用就透明 fallback，不扩大重试到无界。
- source agent 没有可复核的集成、测试和最终交付证据，就不宣称当前版本 live 闭环已经证明。

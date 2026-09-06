# dsh-verifier-autopilot 历史交接快照（2026-08-30）

> 归档说明：以下内容逐字保留自提交 c66199b 的 HANDOFF.md，用于保存旧版 §7b-§7i 实验、环境和运维细节。它记录的是当时事实、外部脚手架和当时实现，不是当前运行契约；当前权威入口是 ../HANDOFF.md。正文中的旧路径、测试数、模型默认值、winner 生命周期和下一步计划均需按当前 HANDOFF 解释。

# dsh-verifier-autopilot 交接说明

> 交接快照：2026-08-30(11)（本轮焦点：best-of-N 操作性一轮修——孤儿候选会话回收、winner 自动释放、结算通知注入源会话、丢弃端点；live 验收 sel-290185b9）。Git 基线：本提交（向下依次 0e62895 交接快照(10)、7b055e0 (9)、1addc34 尾巴收口）。Phase 0-4 机制验收通过；lane kimi-k3 主 / deepseek-chat 副（生产探针全绿）；best-of-N = 逐候选路由 + progressGuard(opt-in) + K=4 期望值；比较层：粗档方向正确（§7f）、细档分辨底界 >1% 档差（§7h⑤）。
> 本文档是下一会话的权威入口。旧的"候选选择尚未实现"叙述已作废——best-of-N 已经上线运行。
> **版面约定（常驻）**：打开本文件第一眼 = **§0a 架构图 + §0b 交接时点运行快照**；往下才是实现细节（§1-§6）与历史深档（§7 系列起）。每次交接只刷新头部本块与 §0b 主表，次序永不后移；复核数据一律并入主表、不另立小节。

## 0a. 架构梳理（2026-08-30 重读上游库校准）

**原点**（llm-as-a-verifier 想要的东西）：R(x,τ) = (1/CK)·Σ_C Σ_K Σ_G p(v_g)·φ(v_g) —— G=20 字母档 logprob **期望值**（非 argmax 单采样）× K 次重复压方差（默认 4）× criteria 分解置 prompt 尾部喂前缀缓存（78.4% 命中、输入 token ÷3.4）。编排层：PPT 锦标赛 O(Nk)（ring pass 消位置偏置 → pivot 集中预算；**输出是 BT 相对胜场强度，不是校准概率**）；ProgressTracker 在线问「当前状态算完成了吗」（hopeless rollout 早弃的框架内解法）。库的形态是**离线 benchmark 框架**；论文锚点：同模型自证 Terminal-Bench Bo5 Pass@1 78.7%→88.0%——我们 k3 候选 + k3 校验正是这个同构形态。

                  共享底座：trajectory.ts 证据管线（10 类噪声排除 + 注入消息过滤 + 16k 钳窗）
        ┌───────────────────────────┴───────────────────────────┐
  A. Verifier 自动验证（事后归责回路）          B. Candidate selection（事前择优）
  turn/end → 门控(裸续问/注入豁免)             /select → preflight 非对称对照门
  → traceFor → 5 lane × 5 lens                → N 真实 child rollout（隔离 workspace、
  → 期望值打分（K=1/lane）                       逐候选异质路由、approval=never）
  → 聚合 + 引用审计 + 分歧守卫                  中途：超时熔断 + progressGuard(opt-in)
  → 低分/高分歧 → [Verifier feedback] 回灌      收敛：checks 免费淘汰 → K=4 锦标赛
  （每会话限频；coordinator 串行调度）           → winner 保活 / loser 清场 / 根目录清扫

- 与库的关系：**A 只借思想**（期望值打分 + 证据纪律），协议全自造——生产回路要 finding 文本、引用审计、回灌注入，库只回分数；**B 是库的正统用户**（经 Python sidecar，密钥只在子进程 env），并修了三处真实接口病（deepseek 采样路径标记、per-run cache 绕 §2.6 退化、K3 mojibake 期望值补丁）。
- 实测账：B 的确定性收益在**鲁棒性层**（7/7 winner 过隐藏电池；零交付/恒等占位 100% 被 checks+failed 淘汰）+ **粗档比较**（6× 差距方向正确）。细档分辨底界 >1%（§7h⑤）——不要再为细档烧 K。A 校准健康（K3 后纯聊天 turn 1.00、真实缺陷会抓）。

## 0b. 运行情况（2026-08-30 09:15 交接时点快照，/selections 与进程表直查）

| 项 | 状态 |
|---|---|
| fiber | active；本轮操作性修复已热重载上线（client ✓）；reload 统计 205✓/0✗ |
| 配置 | enabled ✓、autoFeedback ✓、routes=5、model=kimi-k3、**selectionNotify ✓**（GUI 可切 deepseek-chat 副 lane；v 端点实测应答正常） |
| 自动验证 | records 滚窗 20 条；最新 session-4510e3e0 turn6 1.00 completed（5 lane 均值 0.999986、引用审计全过） |
| selection | active=null、retainedWinners=0、历史 19 条；最新 live 验收 sel-290185b9 N=2 真比较 3 次 winner=c1(0.513)——**loser 会话与工作区结算即回收、winner 自动释放，全部实测生效**；同日 08:52 两条 preflight 'aborted by caller'、09:07 轮 completed 短路 |
| 会话存储 | 候选相关条目 15 个 == 全部与存活 winner workspace 一一对应；历史 25 个孤儿（目录损坏式挂着）已于本轮文件层清除 |
| sidecar 进程 | 过滤器可见 1（uv launcher；base 在 D:/tools/python 不过滤）=fiber 存活期间常驻属正常，reload/dispose 归零 |
| 0.17 旧案复核(08-30) | zstd 重放 session-3f697e20 turn1：rendered 10→2、traceChars ~10k→1234、toolEventCount=0 属实——§7b 修复独立复现成立 |
| 注入器夜班记录 | 08-29 22:31 reload-blocked（client.js 缺失，已随重建消除）；23:18 watch-dangling + precheck-blocked（看门狗保旧代码，保守正确）；08-30 手动重载干净 |
| 运维警示 | 在途 selection 运行期间勿动本仓库源码——watch 重载会打断在途请求（§7h 教训；本日 09:07 轮运行期间同样适用，动码前先 /selections 确认 active=null） |
| 已知待决 | winner workspace 由 operator 在面板「丢弃 winner」自行裁决（自动 GC 仍不做）；§8 取舍清单待拍板 |

## 0. 一句话状态

DSH 已接上 llm-as-a-verifier 的 best-of-N 候选选择：Python sidecar（framed JSONL）→ TS bridge → candidate batch 编排器 → Host API + GUI 面板。真实 N=1/N=3 验收通过（真实 child rollout、真实 verifier 比较、winner 会话保留可用）。

## 1. 新实现地图（src/selection/）

- bridge/llm_verifier_sidecar.py — Python sidecar：serial JSONL、select() 直通、异常分类码、USAGE per-request。协议见 bridge/PROTOCOL.md。
- src/selection/bridge.ts — VerifierBridge：lazy spawn、framing、超时杀子进程重spawn（修过 exit 竞态）、abort、dispose、错误码透传。密钥只走子进程 env，不进帧。
- src/selection/trajectory.ts — 会话事件 → [E*] 证据行；fromSeq 排除 seed 前缀。
- src/selection/checks.ts — 客观检查运行器（pwsh, per-check 超时）。
- src/selection/candidates.ts — SelectionRunner 编排器：workspace 隔离 → 并行 create/drive → turn-error/超时熔断 → checks 淘汰 → verifier select → winner 保留/loser dispose+删目录。scores/ranking 均映射回原始候选序号（非幸存者 score=null）。
  - N=1 与"恰一个幸存者"短路：零 verifier 调用。
- src/selection/live.ts — live 适配：候选 setup 硬配方（见 §2 雷区）。
- src/selection/host.ts — SelectionHost：单在途准入、.data/selections.jsonl 持久化、reload 后 running 归一为 failed。**2026-08-30 起：结算即自动释放 winner 句柄（不再有手动"释放"）；结算通知 [Selection 结算] 注入源会话（plugin 子身份，不占反馈配额）；discardWinner 彻底删除 winner 会话与工作区。**

## 2. 实测出的硬契约（别再踩）

1. NVIDIA relay（chat.holisthoom.top）不支持 structured_outputs choice 约束 → 目标库 vLLM prefill 路径在此 relay 上会静默退化为噪声。**sidecar 必须给 client 打 client._llm_verifier_deepseek = True**（采样得分 tags 的路径，缺 logprob 时 raise，正好合 "不拿 0.5 当证据"）。门禁脚本 eval/smoke/pair_logprob_smoke.py 四道门（G1 原生 logprobs / G2 deepseek 路径 letter mass≥0.9 / G3 lib 抽分 / G4 compare+边界）。
2. **installModelSelection 是候选活命前提**：preset persona 里 prompt variable {{model}} 无值会让首个请求组装失败、turn 立即以 error 收尾。live.ts 内联复制了两段 waterfall（dsh-agent 构建期未链接进插件 node_modules）。
3. 候选必须 pin approval/policy=never（否则 ask 策略下第一个写操作永久停放），sandbox/mode 继承父 override（subagent 配方语义）。
4. turn/end reason.kind === 'error' 的候选是 failed，不进 verifier（N=1 首演就是被这条救下的：此前它会被误记 finished 并直接封 winner）。
5. 旧五路自动 verify 对有 parentSession 的会话不挂监听（attach 守卫）——否则候选 idle 时旧路径会往里注 [Verifier feedback] 污染 select 输入。手动 /verify 不受影响。
6. **select() 没有 cache 文件会静默退化**：库的 tournament 靠 cache 文件在 ring/pivot 两相位间共享分数表；cache=None 时 ring 积累被第二次相位覆盖成空表 → 精确 0.5 平票（实测复现）。sidecar 为每次 run 建临时 cache 文件（run 后即删），语义正确且天然按 run 隔离。
7. **/select 前置 preflight**：宿主在首个候选投身前先过一个小对照对（好轨迹必须严格赢），按 (baseURL, model, apiKeyEnv) 记忆成功；失败即 selection failed、零候选开销。防的是"有 logprob 但不吐 tag"的静默 0.5 长尾 + 不支持通道的烧钱。

## 3. Host API（已实现）

- POST /@dsh-external/dsh-verifier-autopilot/api/select → 202 {selection}（异步跑）。body: sourceSessionId/problem/candidateCount(1-5)/criteria/checks/nEvaluations/pivots/candidateTimeoutMs/selectTimeoutMs/algorithmSeed/candidateModel/candidateProvider（共享候选覆盖）/**candidateOptions**（逐候选路由数组 [{provider?,model?}]，缺省条目回落共享默认；与 candidateCount 同给时两者必须一致，省略 candidateCount 时以数组长度为准；每个候选的实际路由写入 record.candidates[i].agentOptions）。**硬契约：route 必须成对（provider+model）**——只给 model 会在首个候选 turn 报 no provider/model；host 用会话默认路由自动补齐缺失半边（无默认路由时 400 candidate-route-partial）。模型必须在该 provider 的 settings.yaml 注册表中（kimi 已注册：kimi-k3、nvidia/nemotron-3-super-120b-a12b、z-ai/glm-5.2、nemotron-3-ultra-550b-a55b、step-3.7-flash、ox-alpha-free；未注册 id 报 has-no-configured-model）。12 次/小时 rate limit；有 DSH_VA_API_TOKEN 时需要 Bearer。
- GET /selections(?selectionId=) → active + retainedWinners + 近 20 条 record。
- POST /selections/cancel {selectionId}；POST /selections/release {selectionId}（幂等兼容接口——winner 结算时已自动释放，恒回 200 state=not-retained/released；未知 id 才 404）；POST /selections/discard {selectionId}（丢弃 winner：删其会话存储 + workspace，记录写 discardedAt 且 ledger 末行生效）。12 次/小时 rate limit 同上。
- GUI：会话面板两个 tab（Verifier / Candidate selection）+「候选选择 (best-of-N)」区（N、任务覆盖、取消、winner 展示与释放）。渲染已实测：headless Chromium 探针 scripts/gui_probe.cjs（进会话 → 点 tab → 断言两个面板文本）通过。注意：直链 /session/<id> 不水合会话内容，探针必须从侧栏进入。

## 4. Phase 4 实测记录（dist 已在线）

- 源会话：hello.py 任务会话（live 创建，真实完成 turn）。
- N=1：候选 677 事件/12 tool calls，workspace 独立，hello.py 真产出且验证 2.5；nComparisons=0。
- N=3 #1（严格 check）：1 个被客观 check 真淘汰（output 不符）、1 个超时熔断(kimi 慢)、1 个幸存 → 单幸存短路。
- N=3 #2（hello-exists 宽松 check）：3 候选全部真跑（15/12/16 tool calls，轨迹 7-13KB），select() 5 次有向比较（usage 53k in/777 out），scores 0.5006/0.5000/0.4992，winner=c0 保留（session 活、ws 留档），loser 全 dispose+删目录。
- 诚实口径：平凡任务分数几乎打平——机制验证为真，**不声称质量提升**。效果评估换有区分度的任务另测。
- .data/selections.jsonl 已知历史噪声：第一条 N=1 记录产生于 turn-error 门槛修复之前（空 turn 被记为 completed）；另有 preflight 修复前的失败记录。均为本地未入库状态，不要当评估输入。
- GUI 实测：本会话 gui_probe 全过（tabs 出现、两面板文本渲染）。
- 2026-08-28 交接复核：venv 存在且 `llm_verifier 0.2.0 + openai 3.3.1`；sidecar self_test 六门全过；真实 sidecar 进程数 0；`/state` 返回 enabled=true、agents=106，`/selections` 返回 active=null、历史 6 条，插件热重载成功（清缓存 9 模块、重建 1 fiber）。
- 重载后 retainedWinners 为空，符合 fiber dispose 释放内存句柄的设计；winner 会话仍由 DSH session 持久层保留。`.data/selection-workspaces` 保留 13 个 winner 子目录（每个含一个 cN 工件目录），均与历史记录对应；两个历史失败 selection 的空根目录已于 2026-08-30 手动清掉，此后由编排层自动回收（见 §8 尾巴收口）。
- 上轮 verifier feedback 的 0.00 不构成实现反例：该条反馈明确记载无工具结果、无文件变化、无测试证据；本轮已用真实工具补齐证据，未发现新的可复现代码问题。

## 5. 测试与构建基线

- npm test 142/142（含 candidateOptions 4、partial-route 1、progressGuard 3、尾巴收口 3：滑动窗口语义 / /select 拒绝零耗额度 / 失败根目录回收）。sidecar 离线门 8/8（六老 + progress 帧校验 + mojibake 期望值）。
- 2026-08-28 复跑：`npm test` 131/131 ✓；`D:/tools/pyvenvs/llm-verifier-bridge/Scripts/python.exe bridge/self_test.py` 六门 ✓；外部工具链 `tsc -p tsconfig.json --noEmit` ✓；sidecar 进程核查 0。
- bash scripts/build.sh ✓；tsc --noEmit ✓；git diff --check ✓。
- sidecar 离线六门：D:/tools/pyvenvs/llm-verifier-bridge/Scripts/python.exe bridge/self_test.py。
- NVIDIA 门禁：eval/smoke/pair_logprob_smoke.py；sidecar live 验收：eval/smoke/sidecar_live_smoke.py。
- GUI 验收：NODE_PATH=<npx playwright 缓存>/node_modules node scripts/gui_probe.cjs（需已装 chromium-headless-shell）。
- DSH 热重载：dev_reload_package({packageName:'dsh-verifier-autopilot'})。

## 6. 环境

- sidecar venv：D:/tools/pyvenvs/llm-verifier-bridge（llm-verifier 0.2.0 editable + openai 3.3.1）。插件运行时解释器解析顺序：config/env DSH_VA_PYTHON → 该 venv。
- 密钥：~/.dsh/.credentials.yaml 的 KIMI_API_KEY，由 Host credentials resolve 后注入子进程 env（永不进 JSONL 帧/日志）。
- 目标库 D:/tools/llm-as-a-verifier-main 只读使用。
- **模型配额**（异质池配方依据）：z-ai/glm-5.2 走 OpenRouter 免费层，**每日 1000 请求上限**。2026-08-28 实测：单候选一次 /select 消耗 78–105 请求（step 9–25、llm/retry 69–80——重试占大头，relay 对免费层限流显著；这也是它 900s 超时的重要成因）→ 含 glm 的 /select 每天最多约 5-6 轮即触顶。**入池资格纪律（2026-08-28 定）：异质的前提是候选必须"能交付"——nemotron-3-super-120b（§7f 恒等排列占位）与 step-3.7-flash（§7e 两次零交付）已分别有淘汰路径实证，不再入池；淘汰机制已被三次证明，继续给它们名额=纯烧比较轮次。多模型搭配不是目的，合格候选间的质量方差才是。默认主力 kimi-k3；精度分层关键实验才加 glm-5.2（额度敏感）；ultra-550b/gpt-5.x 未作候选测过，保持"未知"不入默认配方。**

## 7. 旧路径现状（共存但标 legacy）

旧五路 verifyFive + autoFeedback + /verify + /probe + /eval 仍在服役（用户开关控制），只加了亲缘守卫。历史数字（99/99、4/4、0/3、repair-v2、strictReady）继续不是新 selector 的证据。是否物理删除旧路径：未定——删除时要保留 build/typecheck/npm test 门与 records 能力。

## 7b. 2026-08-28(2) 验证轨迹去噪修复（本会话）

起因：用户质疑"验证器只会说一句 no tool usage"（0.17 反馈）。用 50 条历史 record + session journal 离线重放（frame-walking zstd 解码 + 直连 lib/traceFor）确证：

- **验证器不是只会这一句**：有工具的 turn 大量 1.00/A；被判 0.00–0.17 的 turn，确定性计数器显示 tools=0 属实（如 turn 1 "干什么" 只渲染 2 行：问+答）。
- **上下文注入本身没断**：turn 6（38 工具）的 prompt 里实有 18 个 TOOL 行，lane 口径"no tool usage"是误说，不是丢数据。
- **但揪出真问题**：request/header（内嵌整份 system prompt + 全量工具 Schema，~6KB/turn）、request/context、session/title(-llm-request)、llm/retry* 全被 fallback 渲染成 [E*] 行；turn 1 的 traceChars=10088 里真实内容只有 USER+ASSISTANT 两行。16k 钳窗下 turn 6 丢了 20/38 个工具行。

修复（commit 见下方 git log）：
1. TRACE_NOISE_EVENTS 扩为 10 类（+request/header、request/context、session/title、session/title-llm-request、llm/retry、llm/retry-started）。
2. 注入型 user/message（runtime context、skill 提醒、审批提示；source.kind≠user）不再渲染进证据窗；直接用户消息与反馈标记行不变。
3. lane 提示加两句：轨迹含 TOOL 行时禁止声称"无工具调用"；末行 ASSISTANT 本来就不该自带 TOOL RESULT，要按全轨迹判。
效果（journal 重放）：turn 1 traceChars 10088→1234；turn 6 工具行窗口存活率 18/38→20/20（journal 口径）。

- lane 提示第三条守卫（同日补）：声称“缺失”（无最终答复/无测试输出）前必须扫含 `[... trajectory tail ...]` 之后的尾段——终答通常是最后一条 [E*] 行。起因：本会话 turn 2 被判 0.88，lane 2/3/5 声称“无最终答复/只读未执行”，journal 重放（live 记录同构：59 rendered）证实 [E59] 为完整终答、G1-G3 探针输出在窗口内——与 turn-6“无工具使用”误述同属“无据缺席断言”家族；管线无缺陷，守卫抑制该失败模式。测试 132/132、tsc ✓、build ✓、热重载 ✓。排障脚手架留在 D:/tools/_trace-dump/（zstd frame walker + traceFor 重放），仓库外、不入 git。


## 7c. 2026-08-28 验证器模型升级：kimi-k3 上岗（替换 Super-120B）

起因：lane 模型原为 Super-120B（AA 26，体感正确）。relay 五模型门禁实测（探针 D:/tools/_trace-dump/probe_lanes.py + 生产路径 POST /probe）：

| 模型 | 原生 logprobs | 标签纪律 | 生产 /probe | 结论 |
|---|---|---|---|---|
| kimi-k3 | ✓ 20 alts/位 | 严格三行 ✓ | hasScoreTags ✓ + scoreTokenLogprobs ✓ | **采用，已设为默认** |
| minimaxai/minimax-m3 | ✓ | 有标签但纪律抖动（生产探针 2 次：1 过 1 挂 malformed_score_tags） | 对半 | 备选（抖动的 lane 由 3-lane 有效底线容忍） |
| nemotron-3-ultra-550b | ✗ relay 不返 logprobs | ✓ | — | 否决 |
| step-3.7-flash | ✓ | 短提示有标签；长 prompt 推理爆炸 | 90s 与 180s 均 timeout（finish=null） | 不推荐（时延超 lane 预算，留档） |
| nemotron-3-super-120b（原默认） | ✓ | ✓ | 历史上工 | 退役 |

落地形态：五路 TS 路径 K3 = logprob 期望值（truthful）；库 select 路径 K3 = 字母标签采样（deepseek tokenizer 把 `<` 拆 mojibake→分布匹配落空→fallback，方向实测正确：对照对 1.0 vs 0.0，3 候选锦标赛 winner 真、分数 0.6155/0.4422/0.4422 非退化）。预flight 门对 K3 的结论以真实 /select 验证为准（compare 严格分胜负已实锤）。

迁移残留（有意保留的尾巴）：①python 侧若要期望值粒度，给 _find_tag_logprobs 加 mojibake 容忍（扫 score/_A/> token 串，取后一 token 分布）；②eval/smoke/pair_logprob_smoke.py 仍是 Super 专用形态，K3 版门禁可克隆 probe_lanes.py 演化；③GUI 设置面板可继续覆盖 model，配置项本身从未写死——写死的只是默认值。同日落地三选一：Verifier 面板新增模型下拉（kimi-k3 推荐 / minimax-m3 备选 / step-3.7-flash 不推荐-留档），走 settingsScope 持久化（缺该服务时回退 POST /config）；GUI 探针六断言全绿（scripts/gui_probe.cjs 的 hint 改为读 textarea placeholder，title 断言随化石命名 'Nemotron 自动验证'→'Verifier 自动验证' 同步更新）。

## 7d. 2026-08-28(4) 效果评估实测（§8.1 结算）

方法：三个刻意带陷阱的任务（A 闭区间合并：相邻合并与不修改入参；B 词频统计修 bug：大小写归一+并列词典序；C 十进制金额：0.105 半进/余数分配，浮点捷径必踩），各跑 N=3；pipeline checks 刻意宽松（存在性+冒烟，不参与淘汰），verifier criteria 双轨（真实执行证据 / 规格忠实度证据）。每轮结束后用**独立隐藏电池**（15/15、6/6、15/15 assert，含任务中未暴露用例；电池先经参考实现与阳性故障实现对校）对全部候选工件评测——winner 测保留 workspace，loser 从其 session journal 的 tool/code-dispatch 载荷重建工件再测（脚手架 D:/tools/_trace-dump：battery_a/b/c.js、extract_impl.cjs、recon_cand.cjs）。

记录：sel-3699fb1c（A）/ sel-9e4c14ea（B）/ sel-5fe0b270（C），verifier=kimi-k3，每轮 nComparisons=5（select 库锦标赛，letter 采样路径），usage 每轮 47k-76k in / ~4k out。

| 轮次 | checks 淘汰 | scores 散布 | winner 电池 | loser 电池（重建后） |
|---|---|---|---|---|
| A 闭区间 | 0/3 | 0.4978/0.5000/0.5016 | 15/15 ✓ | 15/15、15/15 |
| B 修 bug | 0/3 | 0.4967/0.5000/0.5044 | 6/6 ✓ | 6/6、6/6 |
| C 金额 | 0/3 | 0.5000/0.5022/0.4984 | 15/15 ✓ | 15/15、15/15 |

结论（诚实）：
1. **机制层全部坐实**：K3 上真实 /select 的 preflight 3/3 通过（§8.2(b) 尾巴关闭）；比较真实发生；winner 3/3 客观正确；loser 工件虽被删除但可从 journal 完整重建审计。
2. **未观察到客观散布**：9/9 候选工件全部通过隐藏电池——kimi-k3 候选池在这三个任务上强且同质。verifier 的近平分（±0.005）是对"无真实差异"的诚实表达，符合停止条件第 2 条，不算失效。
3. **效果断言仍未成立、也未被推翻**：观测不到"winner 更好"的前提是候选池先产生差异。已知杠杆：当前 API 每个 selection 只支持单一 candidateModel——**跨候选混合模型是验出效果的前提性功能缺口**；或选用 k3 也会翻车的高难任务。
4. 工具化收益：journal→工件重建管线（extract_impl.cjs）使 winner/loser 事后客观审计成为标准动作，本轮已验证可用。

## 7e. 2026-08-28(5) 异质候选池（candidateOptions）落地与实测

动机：§7d 判定——同质 k3 池下效果不可分离；需要逐候选模型混合。

实现：host.ts 解析校验 candidateOptions（数组长=候选数、未知键拒收、与 candidateCount 冲突 400 齐不齐）→ completeRoutePair 用会话默认路由补半（无默认路由 400 candidate-route-partial）→ SelectionRunInput.candidateOptions → SelectionRunner 逐候选传入 factory spec 并记进 record；live.ts 工厂 per-spec 覆盖共享默认；index.ts 经 agentDefaultModel.currentSelection 供默认路由。测试 136/136（+4：异质下发与记录回写、共享默认值合并、非法/数量不符拒收、无默认路由时 partial 拒收）。

两轮实测（第三轮验证任务=金额精度，同 §7d-C）：
- sel-7f671e2f：对模型注册表无知交学费——minimaxai/minimax-m3 未在 provider kimi 注册 → 该候选 turn-error'has no configured model'（fail-fast 正确）；step-3.7-flash 候选跑满轨迹（7 次工具调用、192 reasoning chunks）**但从未写出 money.js**（自我怀疑漂移："Since I can't directly write files...let me output the file contents"），两个 checks 双双淘汰；k3 单幸存短路。全程机制行为正确。
- sel-8d778422（k3 / glm-5.2 / flash）：flash 再现"不写文件"漂移被 checks 淘汰；k3 与 glm-5.2 双双幸存且隐藏电池均 15/15；verifier 3 次比较判 glm-5.2 微胜（0.5044/0.4956）——两者客观等价，差值在噪声内，又一次诚实的近平分。

沉淀结论：
1. **异质池打通了**，§7d 记的功能缺口关闭；用法与两条硬契约（成对路由、注册表）已写入 §3。
2. 到目前为止，best-of-N 可实证的价值集中在**鲁棒性层**：质量方差真实出现在交付层（flash 零交付），checks+failed 标记零容忍吸收之，winner 始终客观可靠（6/6 轮 winner 通过隐藏电池）。
3. verifier 比较层的增量价值仍未被证伪/证实：幸存者对始终客观等价。真要分离比较层价值，需要一个"交付完整但精度分层"且弱模型也会交付子优解的任务（如软约束优化/启发式检索质量），候选池混合 k3 × glm-5.2。

## 7f. 2026-08-28(6) 精度分层决定性实验（比较层价值首证）

设计思想（针对 §7d/§7e"幸存者总等价"的破局）：换**连续标量质量**任务——TSP 启发式求解器（tour.js，stdin 喂坐标，输出排列，总长越短越好），任务书不点名任何启发式，让算法选择自然分层；池：kimi-k3 × glm-5.2 × nemotron-3-super-120b（混池）。隐藏电池 battery_tsp.js 在 3 个任务书未含的固定实例（20/50/100 城，聚簇）上测总长；电池三档校验（naive 48785 > NN 9117 > NN+2opt 8128）保证分辨力。checks 宽松（存在+5城排列合法），决策权留给 verifier（criteria：真实运行数字 + 算法改进力度）。

结果 sel-4fcbc905（verifier=kimi-k3，nComparisons=3）：

| 候选 | 模型 | 状态 | 轨迹 | verifier 分 | 隐藏电池 TOTAL | 算法真相 |
|---|---|---|---|---|---|---|
| c0 | kimi-k3 | **winner** | 4 工具调用 | **0.649** | **7957.813** | 多起点 NN + 2-opt |
| c1 | glm-5.2 | failed（candidate-timeout 900s） | 25 工具调用 | null（未进 select） | **7947.691（全场最优）** | NN + 2-opt **+ Or-opt** |
| c2 | super-120b | loser | 50 工具调用 | 0.351 | **48785.300（与裸顺序输入逐比特一致）** | 最终工件是恒等排列占位（identity permutation） |

结论（诚实边界内）：
1. **比较层首次给出非噪声级区分且方向正确**：0.649/0.351 对应客观 7958 vs 48785；此前同质实验的 ±0.005 摆动与本次 ±0.15 的幅面差异，说明 letter 采样粒度的分辨率够判"真伪档"级差异。
2. **超时规则吞掉全场最优**是设计行为（timeout=failed 不进 select），但暴露使用经验：glm-5.2 这类慢磨模型需要 >900s 的 candidateTimeoutMs；它 25 次调用里已写出并磨出含 Or-opt 的工件。**读数防误读：glm 7947.7 vs k3 7957.8 差 0.13%，属单任务单样本噪声级（两者同档：NN+2opt 系 vs 加 Or-opt 算子），不构成"glm≻k3"证据——公开基准的聚合结论仍以多任务统计为准；本实验的有效信号只是"该任务上两者同属一档"。**
3. super-120b 的 50 次工具调用最终交付恒等排列——活动量与交付质量可能严重背离，trajectory 里的"忙"不构成证据。（本结论辅助佐证：glm-5.2 的 900s 超时与 relay 免费层限流重试风暴强相关——25 step 伴随 80 次 llm/retry，见 §6 配额条目；时长预算评估慢模型时需把重试膨胀计入。）
4. 综合 §7d§7e§7f 三阶段：机制可靠（7/7 winner 客观正确）+ 抗不交付/抗翻转（flash×2、super×1 零进入终选）均有实证；比较层在"有一个明显差档"时判别正确。"两个都认真但精度微差"的细分辨率判别仍未直接实测（本实验只出现了粗档差）——如需饱和，下一组应构造"NN vs NN+2opt"级别的相邻档差任务。

## 7g. 2026-08-28(6b) 回源码重读——框架真实面貌与我们的偏差

**库本来押注的三件事（fine_grained_reward.py 实读）**：①期望值粒度（G=20 字母档上对 logprob 分布取期望）；②K 次重复（temperature=1.0 的字母采样再平均；select/compare 默认 n_evaluations=4）；③criteria 分解 + criterion 置 prompt 尾部以喂前缀缓存（自查表 78.4% 命中）。锦标赛（pivot_tournament.py）是 Bradley-Terry 软胜分（sigmoid(Ra-Rb)）环形排位——**输出分数是池内相对胜场强度，不是校准概率**（§7f 的 0.649 不可读作"64.9% 置信"）。

**我们对框架的偏差清单**：
- 自废武功级：**n_evaluations 我们一直传 1**——字母 fallback 下 K=1 意味着每次比较有且仅有一次离散采样，"期望"退化成"一锤定音"，§7d 近平分与 §7f 粗档分裂的方差形态均与此直接相关。改 K=4 是一行参数的升级。
- prefix cache 实测 0%：K=1 无可重复前缀对 + relay 端是否缓存未证。K 提升后可顺带观察。
- 我们的五路 lane verdict（finding 文本 + 引用审计 + 反馈回灌）是库外的平行协议，生产反馈回路需要文本，保留；但不要两边混用语义。
- cache 侧车 per-run 临时文件 = 只绕开 §2.6 退化，不产生跨 run 复用（每次候选全新，cache key 永不命中，行为正确）。
- DEEPSEEK_EFFORT sidecar 默认 off（防 thinking 吃掉 tag 预算——flash 作为 lane 的死因之一）。

**框架里我们没用上的武器**：ProgressTracker/track——按步在线打分，设计用途即" hopeless rollout 早弃 / resample"（README 原话）。这是 §7f glm 900s 白烧超时问题的框架内解法，也能产生过程维度证据。

**方向级结论**：论文自述同模型自证在 Terminal-Bench Bo5 上 Pass@1 78.7%→88.0%——体系天然适配我们"k3 候选+k3 校验"形态；§7f 的粗档正向判别与之一致，细档判别的入场券是 K≥3-4（先上 K=4 再谈 §7c-a 的 mojibake 期望修复，两者叠加才是完整粒度）。另一个立查项：**deepseek-v4-flash 是 0.2.0 官方 verifier 默认 backend**（papers 自证赛的双料选手），且已注册在 xaohongshu provider——值得过一次 lane 门禁探针，过则成 K3 之外的第二名合法 lane。

## 7h. 2026-08-28(7) §7g 序列落地（K=4 / mojibake 期望值 / flash 门禁 / ProgressTracker / K4 复测）

① **nEvaluations 默认 1→4**（candidates.ts/bridge.ts；preflight 刻意保持 K=1 廉价门）。K4 重测的 verifier 成本实测：5 次锦标赛 → 32 次校验调用 / 170k in（≈4× K=1）。本 relay cached_input 恒定 0（不缓存），K 增大按线性换算预算。
② **mojibake 期望值补丁落地**（`bridge/llm_verifier_sidecar.py`：stock 未命中时按 'score/_A/>' 三元组取后位分布，闭标签因带 '</' 不落此族）。在线验证：K3 compare 的 ra/rb 从字面 1.0/0.0 变为期望值 **0.99999 / 0.00045**（fractional 实锤）。§7c-a 遗留关闭。offline 门 6→8（mojibake_expectation 合成流 ra=0.947/rb=0.053、progress 帧校验）。
③ **lane 候选裁决**：deepseek-v4-flash 在 relay（KIMI 组）404；xhs 组可达但**无 logprobs**（否决）；官方 api.deepseek.com 两个形态实测——**deepseek-chat 生产 /probe 全绿（~1s、scoreSource=logprobs、strictReady）→ 收编为副 lane**；deepseek-v4-flash 4096 预算被 reasoning 吞噬（finish=length 不完整），8192 能过但 51s/次不推荐。GUI 下拉升级为端点三元组自携带（model+baseURL+apiKeyEnv 同存），选项 5 个（k3 推荐 / deepseek-chat 备选 / m3 备选 / ds-v4-flash 不推荐 / step-flash 不推荐）。GUI 探针 6/6。
④ **ProgressTracker 在线弃子（progressGuard, 默认关）**：侧车新增 progress 帧（track 单末检点，"当前进度能否已完成"分）；编排层每候选监视器按 interval 采样渲染轨迹，连续 grace 次低于 minScore 且无新工具证据 → 取消并记 'progress-abandoned(lastScore=…)'；maxChecks 封顶。动机案例：§7f glm 900s 白烧。139/139（卡住而冻死的候选 2.0s 被弃、健康候选不误伤、校验拒收非法形状）。
⑤ **K=4 细档复测定论**（sel-f78b5d20，同源 k3×3，TSP）：电池真相 c0=7954.4 / c2=8000.6 / c1=8056.3；verifier 排序 [c2,c0,c1]、分数散布 ±0.005——**0.58% 档差分辨不出**（c0/c1 冠亚换位错误、榜底正确）。结论：细档判别的当前分辨底界高于 1%；实务上"这个档差内任意 winner 都可用"。继续压分辨率需调用级变量（更多 criteria 或更强判据），不建议为此烧钱。

另记录一条运维教训（非代码缺陷）：**交接期间编辑本仓库源码会触发 watch 自动重载，进行中 selection 被打断为 aborted**（sel-76e81355：'sidecar request aborted by caller'）。重跑前先收口本站源码。

## 7i. 2026-08-30(11) 操作性一轮修：用户实测暴露的四类乱象收口

用户实测反馈（原话要点）：每次手动开选且"点了之后不明不白"；主会话同时推进、结果无处可见；"释放 winner"语义吓人；**用完的候选子会话不回收，在会话列表以"目录损坏"形式挂着**。

**实锤盘点（修前）**：~/.dsh/sessions 里候选会话条目 39 个，其中 25 个的 workspace 已被编排层删掉——会话连同完整 zstd journal 残留在存储里，GUI 会话列表照常列出即"目录损坏"幽灵。根因：disposeLoser 只 dispose 内存句柄 + 删 workspace，**从不删会话存储**。"释放"按钮只 dispose 内存句柄（对磁盘零效果，纯属吓人）。

**修法（全部细节级、当轮落地）**：
1. **loser 会话存储随处置回收**：WorkspaceManager 新增可选 purgeSessionRecord（live.ts 实现 = dsh-session-persistence-jsonl projectKey 编码的忠实 port + rm 会话 store 目录），disposeLoser 在 dispose 之后调用（防 journal flush 复活）。
2. **winner 结算即自动释放**：finishRun 内联 dispose，retainedWinners 恒空；"释放"端点改幂等 200。winner 会话本就以普通身份留在持久层，侧栏直接可开。
3. **结算通知注入源会话**：[Selection 结算] 一条 plugin 消息（子身份 .../selection——不占反馈配额、不进证据、不作种子），config selectionNotify 默认开。
4. **丢弃通道**：POST /selections/discard 删除 winner 的会话存储 + workspace，记录 winner.discardedAt（ledger 末行生效，加载按 selectionId 去重保留最后一条）。GUI 面板：释放按钮下线、逐候选状态行、"丢弃 winner"按钮、结算语义一句提示。

**验收**：测试 148/148（+6 新用例：loser 回收、discard 幂等、ledger 去重、notice 开关、配额隔离、projectKey 编码）；tsc/build ✓；热重载 ✓（client ✓）；GUI 探针全绿。live 验收 sel-290185b9（N=2、真实 3 次比较、winner=c1 0.513）：会话存储从 14 个 winner 条目增至 15（新 winner）而**没有产生 loser 幽灵**，retainedWinners=0、结算通知落源会话。

存量清理：25 个孤儿候选会话文件层删除（~2.2MB）；14 个历史 winner 会话/工作区原样保留（用户可自行"丢弃"）。

## 8. 下一步候选（不是承诺）

1. ~~效果评估~~ **已结算（§7d§7e§7f）**：机制坐实、鲁棒性层入证实、比较层粗档判别方向正确。**续作（按 §7g 重读结论排序）**：(a) select 的 nEvaluations 默认 1→4（K 次字母采样求均值，一行默认参数；测代价 ~4x 校验 token）；(b) ProgressTracker 在线早弃/复采样，治慢模型白烧超时；(c) §7c-a mojibake 期望值粒度（与 (a) 叠加）；(d) deepseek-v4-flash 过 lane 门禁（0.2.0 官方默认 verifier backend），过则 K3 有副 lane；(e) 细档判别实验（相邻档位精度差）须在 (a) 落地后再测。
2. ~~Kimi K3 迁移评估~~ **已完成**（§7c 五门禁实测；§7d preflight 3/3 实跑通过；§7h② mojibake 期望值补丁落地——K3 上 select 分数现为 logprob 期望值而非字母单采样，残余期望碎片 (a)(b) 均已关闭）。探针脚本：D:/tools/_trace-dump/probe_k3.py、probe_lanes.py。
3. workspace 共享保真：git worktree 已实现；非 git 源目录当前=全新空目录（不保真共享）——需要更真前缀是有意打磨项。
4. 上游反馈选项：向 llm-as-a-verifier 提 fact——select(cache=None) 会静默退化 ring 积累（见 §2.6）；我们靠 sidecar per-run cache 规避。

已完成无需再做：GUI 浏览器验收（探针在库）、preflight 门（§2.7）、提交策略（已分三笔固化到 main）、实现级审核三修（/select 准入 TOCTOU 重排到 claim 前零 await、health 先调后首条带 key 请求强制重 spawn、prepare 失败去 '(unavailable)' 哨兵防 rm 相对路径误伤）。checks 超时不杀孙进程是已记录的 Windows 边界（checks.ts 注释），不修。2026-08-28 环境复核未发现新的可复现代码问题，verifier feedback 的 0.00 仅反映上一轮缺少工具轨迹证据，不改变实现结论。剩余低优先级项（2026-08-30(11) 收口后）：winner workspace 去留已由 §7i 的「丢弃 winner」交给 operator 裁决（会话+工作区一键删除）；自动 GC 策略暂无。
本轮已收口的尾巴：
- **/select 额度纪律**：`createRateLimiter` 改滑动窗口日志（固定窗口边界 2x 突发消除；时钟可注入、已导出供回归），/select 拆 peek/commit——host 拒绝的准入（busy、坏路由、缺 key）不再消耗 12/hour 额度，只有真实 admitted start 才 commit。eval/probe/verify 保持 acquire 语义不变（其 404 仍计数，属防滥用设计）。
- **失败 selection 空根目录回收**：编排层收尾时对无 winner 的 run 用非递归 rmdir 扫掉 `<root>/<selectionId>`（非空即跳，绝误删 winner workspace）。
- **『双 sidecar 常驻残留』误诊平反**：该 venv 由 uv 0.11.19 创建（pyvenv.cfg home=D:/tools/python），其 Scripts/python.exe 是转发 launcher——每个逻辑 sidecar 在进程表恒为 launcher+base 两个进程（父子链实锤 node→launcher→base）。2026-08-30 离线探针直接驱动生产 lib 的 VerifierBridge：keyless health=2 进程 → 带 key 强制重 spawn 后仍=2（旧对被回收）→ dispose=0。重 spawn 与 dispose 回收路径无泄漏；此前观测到的"驻留对"系测试运行窗口内的采样，测后自行退出。

## 9. 停止条件（沿用）

缺 logprob 证据就失败/raise、不许 0.5 充数；候选无真实差异时不声称效果；winner 必须映射回真实 child session/workspace。遇到 relay 对 deepseek 路径也不支持时，停止并报告，不翻译近似实现。

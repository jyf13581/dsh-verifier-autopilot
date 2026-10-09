# R6 审查报告：架构可维护性与构建/发布链

- 范围：`src/` 全部模块，`scripts/build.sh`、`tsdown.config.ts`，`.github/workflows/ci.yml`，`package.json` 的依赖声明
- 基线：`d10fec4`（R5 收尾，314/314）
- 结果：329/329（新增 15 个测试），`check:architecture`、`check:contract`、`typecheck` 通过，`bridge/self_test.py` 14 项 PASS
- 回归测试：`scripts/tests/build-contract.test.mjs`（6.2/6.3/6.4/6.6）、`scripts/tests/coverage-gaps.test.mjs`（6.5）
- 提交：`316b37e`、`8bb1342`、`6d6d87c`，以及本报告所在的文档提交

## 1. 目标与方法

计划给 R6 的验收是三样东西：拆分设计（本轮只做设计，不做大重构）、统一的构建路径方案、覆盖率报告和测试缺口清单。实际做法：

1. **模块体量和依赖图**：用 TypeScript AST 列出三个最大模块里每个类成员和顶层函数的行数（§4）；依赖方向由 `check:architecture` 给出（26 个模块，69 条运行时边，18 条纯类型边，0 个环）。
2. **两条构建的产物对比**：分别用 tsdown（CI）和 `build.sh` 的 esbuild 打包客户端，比较 externals、包装方式和全局变量。在 `vm` 里模拟 DSH 的延迟模块加载器，把两份 bundle 都加载一遍（§3）。
3. **类型契约**：把插件手写的 DSH agent 视图和已安装的 `@deepseek-ai/dsh-agent` 声明做类型级比对。这一步找到了本轮最严重的问题 6.6a。
4. **覆盖率热力图**：`node --test --experimental-test-coverage`（Node 22.22.3），再把未覆盖的行区间映射回所在函数（§5）。
5. **Windows**：生产环境是 Windows，CI 只有 Ubuntu。本轮没有凭推测写矩阵设计，而是直接加了一个只观察、不阻断的 `windows-latest` 任务，跑了三轮，用实际失败来定设计（§6）。它找到了两个真实的产品缺陷，6.5a 和 6.5b。

## 2. 发现与处置

| # | 严重度 | 发现 | 处置 | 位置 |
|---|---|---|---|---|
| 6.6a | **高**（新） | **取消候选时没有带原因**。候选超时和 progress guard 放弃候选都调用 `agent.cancel?.()`，不传参数。DSH 的 agent loop（`dsh-agent-loop` ≥ 0.1.7-rc.1，在我们的 peer 范围内）结束被中止的 turn 时，用穷举 switch 把取消原因映射成 `turn/end` 的 reason，default 分支是 `assertNever`：空对象会抛 `unreachable variant: {}`，`turn/end` 拿到 `undefined`，driver 报错。**每一次候选超时和每一次 progress guard 放弃都会触发**。用已发布版本的函数原样复现过 | 两个调用点传 `CANCEL_CANDIDATE_TIMEOUT` / `CANCEL_PROGRESS_GUARD`，形状为 `{kind:'hook', reason}`；新增类型契约（6.6b）防止再次漂移 | `candidates.ts:224-225`、`:714`、`:783` |
| 6.5a | **高**（新） | **Windows 上的 git 证据是在警告文本上算出来的**。Git for Windows 安装时默认 `core.autocrlf=true`，git 每列出一个 LF 文件，就往 stderr 写一行 `warning: in the working copy of 'X', LF will be replaced by CRLF`。`live.ts` 通过合并 stdout+stderr 的 `runProcess` 读取 git 输出，这些警告混进了 NUL 分隔的路径列表。后果：三个内容不同的仓库指纹全是 `43ff21557eb328cc`，即**不同的交付物被当成重复去重**（R2 2.1 在 Windows 上失效）；候选自己的改动数虚高（1 变成 3、4）；采纳归因（R3 3.3）列出了警告文本；审计补丁（R5 5.6）丢掉了候选自己的改动 | `runProcess` 增加 `separateStderr`：退出码为 0 时 `out` 只含 stdout，失败时才在后面附上 stderr 尾部，git 的失败原因仍然保留。`live.ts` 的 git 调用全部使用它；check 命令仍然合并输出。在 Linux 上用 `GIT_CONFIG_COUNT` 注入 `core.autocrlf=true` 复现，旧代码失败 | `proc.ts runProcess`、`live.ts exec` |
| 6.5b | **高**（新） | **源目录换一种写法就被拒绝**。`prepare()` 对 git 打印的 toplevel（长路径，已解析符号链接和 junction）和调用方给出的 cwd 直接做 `path.relative`。两者是同一目录的不同写法时，结果是 `..\..\…`，选择被拒为 `source-cwd-outside-git-root`。Windows runner 上 `os.tmpdir()` 是 8.3 短名 `C:\Users\RUNNER~1\…`，第一轮 Windows CI 几乎所有工作区测试都因此失败。同样的问题在任何系统上都会拒绝通过符号链接或 junction 打开的仓库，Linux 上已复现 | 两边都先 `realpath`（libuv 的原生实现，Windows 上会展开 8.3 短名并解析 junction），失败时退回 `path.resolve` | `live.ts canonicalDir`、`prepare` |
| 6.2 | 中 | **发布构建和 CI 构建不是同一个**。负责人用 `build.sh` 发布：tsc 来自 `D:/` 下另一个插件且版本不固定；依赖通过符号链接指向 `D:/` 下的宿主路径，而且会 `rm -rf` 掉 npm 安装的包、换成链接，悄悄替换掉锁文件里的版本；客户端由 esbuild 打包，externals 只有 react，而 CI 的 tsdown 还排除了 cordis 和 ui-slots；esbuild 的包装把 `var module/exports` 放在顶层，在页面上成了全局变量（会干扰 UMD 检测，属于卫生问题，没有证据表明已经造成故障）。**CI 测试的产物不是发布的产物** | 方案见 §3：一份 bundle 规格（`scripts/client-bundle.mjs`），tsdown 和 esbuild 回退共用；`build.sh` 在装了锁文件工具链时直接执行 CI 的两条命令；`link_dep` 不再替换 npm 安装的包；CI 额外跑一次强制回退；测试用延迟加载器把两份 bundle 都加载一遍并比较导出 | `build.sh`、`tsdown.config.ts`、`client-bundle.mjs` |
| 6.3 | 中 | **缺省值和常量漂移**：`/select` 超时回落 180 s，配置是 600 s；`600_000` 字面量散落在三个文件；注释写 “300s floor”，实际是 600000；P（pivots）在 runner 和 bridge 回落 1，配置是 0；sidecar 注释写“默认 effort max”，配置是 low | 每个值在 `constants.ts` 只有一个常量（`DEFAULT_SELECTION_PIVOTS`、`SELECTION_TIMEOUT_MIN/MAX_MS`、`DEFAULT_SELECTION_TIMEOUT_MS`），各处引用；注释改正。P 的缺省值变了，`bridge/protocol-fixtures.json` 的标准 select 帧随之改为 `pivots: 0` | `constants.ts`、`config.ts`、`candidates.ts`、`bridge.ts`、`autopilot.ts`、`selection/host.ts` |
| 6.3b | 低 | `OPERATOR_BRIDGE_VENV_PYTHON` 硬编码 `D:/tools/pyvenvs/…` | 不改，列入决策表（这是负责人机器上的约定，改动会影响现有部署） | `selection/host.ts:212` |
| 6.4a | 中 | **`/select` 的数值字段没有类型校验**：`nEvaluations: "abc"` 返回 202，到所有候选跑完、开始排名时才变成 `NaN` 交给 verifier | 新增 `finiteRequestNumber` / `optionalRequestNumber`：不是有限 JSON 数字就返回 400 `numeric-field-invalid` | `selection/host.ts` |
| 6.4b | 低 | `check:architecture` 只禁止 `as never` 和 `as unknown as`。盘点 81 处类型断言：24 处从 `unknown`/`any` 断言（没有人检查过形状），26 处收窄，29 处放宽，2 处无关 | 新增**基于类型的棘轮**：对 `unknown`/`any` 的 `as X` 按文件计数，与 `scripts/untyped-casts.json`（24 处，9 个文件）**精确比对**。新增一处会失败并列出位置；减少一处也会失败，直到基线被调低，所以余量不会积累。`--update-cast-baseline` 重写基线。两个方向都做过实测 | `check-architecture.mjs` |
| 6.6b | 低 | peer 依赖 `@deepseek-ai/dsh-agent` 在源码中没有被引用 | **保留**，并让它有实际作用：`scripts/contract/dsh-agent.contract.ts` 把插件手写的 agent 视图和该包的声明做类型级比对（`npm run check:contract`，已进 CI）。6.6a 就是它找到的；对旧源码运行时会失败 | `scripts/contract/` |
| 6.1 | 中 | 三个模块过大，职责混杂：`SelectionRunner.run` 一个方法 627 行；`VerifierHost` 里约 480 行是 autopilot（准入 184 行、winner 清理 113 行、relay 快照/恢复/通知），与 legacy 验证无关；`SelectionHost.start` 230 行，大部分是请求解析 | 本轮只做设计（§4）。为它做的准备已经落地：覆盖率缺口的特征测试（§5）、类型断言棘轮、类型契约 | `candidates.ts`、`host.ts`、`selection/host.ts` |

另外更正一个本轮早些时候的说法：曾怀疑 esbuild 的顶层包装会让工厂函数拿到相邻模块的 `exports`。核对 esbuild 的输出后确认**不会**：每个工厂都同步地给 `module.exports` 赋值并返回。真正的问题只是 `window.module` / `window.exports` 成了页面全局变量（6.2）。

## 3. 统一构建路径（验收项）

| | 之前 | 现在 |
|---|---|---|
| 发布者运行 | `bash scripts/build.sh` | 同一个命令 |
| 装了锁文件工具链（`npm ci`）时 | 仍然走 `D:/` 下的 tsc 和 esbuild，依赖链接到宿主路径 | **直接执行** `npm run build:host` + `npm run build:client`，和 CI 完全一致 |
| 没有 `node_modules`（HANDOFF §5 的已安装 DSH 环境） | esbuild，externals 只有 react，顶层包装 | 仍然可以用回退，但 externals 和包装来自同一份 `client-bundle.mjs`；不会替换已安装的包 |
| CI 是否覆盖回退 | 否 | 是：`DSH_BUILD_FORCE_INSTALLED=1 bash scripts/build.sh`，然后重新构建常规产物 |
| 两份 bundle 是否等价 | 无法知道 | 测试在模拟的 DSH 延迟加载器里加载两份 bundle，比较导出，并断言没有泄漏页面全局变量 |

后续建议（不在本轮做）：在 release 流程里只接受 `build: complete (lockfile toolchain, same as CI)` 这一行输出，回退只留给无法 `npm ci` 的机器。

## 4. 6.1 拆分设计（验收项，只做设计）

体量（AST 统计，仅列 ≥ 8 行的成员）：

| 模块 | 行数 | 最大的成员 |
|---|---|---|
| `selection/candidates.ts` | 1185 | `SelectionRunner.run` 627 行（547–1173） |
| `selection/host.ts` | 1164 | `SelectionHost.start` 230 行；`safe*` 校验函数 5 个约 110 行 |
| `host.ts` | 940 | `handleAutopilotPreStep` 184 行，`cleanupAutopilotWinnersOnce` 113 行，`verifyAgent` 89 行 |
| `selection/live.ts` | 约 890 | 工作区、git 证据、候选工厂三块 |

拆分分三步，每步都不改变行为，只移动代码。每步的门禁：全部测试通过；覆盖率不下降；`check:architecture` 增加对应的层级规则；类型断言基线不升高。

**第 1 步：`selection/admission.ts`（最小、纯函数）。** 把 `safeChecks`、`safeCandidateOptions`、`safeProgressGuard`、`safeCriteria`、`validateStartScalars`、`finiteRequestNumber` 和 `start()` 前半段的解析移进 `parseStartRequest(body, deps) → StartPlan`。`start()` 只剩“计划 → 准入 → 启动 runner”。收益：校验可以脱离 host 单独测试，24 处无类型断言里有 3 处在这里，会被读取器替换。层级：只依赖 `constants`、`util`、`payload`。

**第 2 步：`autopilot-controller.ts`（`AutopilotController`）。** 从 `VerifierHost` 移出 `handleAutopilotPreStep`、`cleanupAutopilotWinners(Once)`、`snapshotSourceAtRelay`、`notifySelectionSettlement`、`recoverAutopilotRelays` 以及 relay 相关的状态，约 480 行。`VerifierHost` 保留 legacy 验证、attach/detach 和组装，持有 `autopilot: AutopilotController`。依赖：`SelectionHost` 的公开接口、agent 注册表、配置读取函数、diagnostics、时钟，全部通过构造参数注入，测试可以直接构造。层级规则：`host.ts` 可以 import 它；`selection/*` 不可以 import 它。

**第 3 步：把 `SelectionRunner.run` 拆成阶段函数。** 每个阶段接收一个 `RunContext`：

1. `prepareWorkspaces`：seed 快照和工作区租约（R4 4.2）
2. `runCandidates`：agent 循环、超时、progress guard、取消原因（6.6a），可以单独成为 `candidate-session.ts`
3. `collectEvidence`：轨迹渲染、diff、checks、脱敏（R5 5.1）
4. `rank`：去重、bridge select、margin 策略（R3 3.1）
5. `settle`：记录、产物、保留和清理

这一步风险最大，所以放在最后：它依赖第 1、2 步之后更窄的接口，也依赖本轮补上的特征测试（`makeChildSetup`、重试中止）。

## 5. 覆盖率报告与测试缺口（验收项）

全量 321 个测试（加入 `coverage-gaps` 之前）：行 96.57%，分支 85.63%，函数 93.35%。低于整体水平的文件：

| 文件 | 行 | 分支 | 函数 |
|---|---|---|---|
| `index.ts` | 80.85 | — | 0 |
| `selection/retry.ts` | 85.71 | 86.27 | — |
| `selection/autopilot.ts` | 93.94 | 73.68 | — |
| `selection/live.ts` | 95.30 | 73.57 | — |
| `api.ts` | — | 78.03 | — |
| `host.ts` | 96.59 | 81.82 | — |
| `selection/bridge.ts` | — | 80.90 | — |
| `selection/proc.ts` | — | 79.22 | — |
| `selection/checks.ts` | — | — | 77.78 |

未覆盖的行按所在函数归类（括号内为行数）：

| 文件 | 函数 | 状态 |
|---|---|---|
| `live.ts` | `makeChildSetup`（21） | **已补**：沙箱和审批模式、继承父级 `sandboxPolicy`、深度、preset、路由注入到 `system-prompt/assemble` 和 `agent/request`、缺省模型、非 scope 的 setup |
| `retry.ts` | `abortableRetrySleep`（15） | **已补**：中止路径 |
| `live.ts` | `prepare` 中的路径比较 | **已补**：junction 或符号链接形式的源路径（6.5b） |
| `live.ts` | git 证据在 `core.autocrlf=true` 下 | **已补**（6.5a） |
| `autopilot.ts` | `buildAutopilotRelay`（16） | 缺口 |
| `selection/host.ts` | `safeProgressGuard`（14）、`bridge`（8）、`start`（8）、`loadSelections`（6） | 缺口；第 1 步拆分后可以直接测 |
| `bridge.ts` | `onStdout`（12）、`request`（9）、`ensureSpawned`（6） | 缺口（分帧的异常分支） |
| `host.ts` | `handleAutopilotPreStep`（10）、`cleanupAutopilotWinnersOnce`（7） | 缺口；第 2 步拆分后可以直接测 |
| `checks.ts` | `runOne`（10） | 缺口 |
| `api.ts` | `apiRoutes`（13） | 缺口 |
| `index.ts` | `apply`（9） | 缺口（插件入口，只有真实 DSH 才会调用） |
| `proc.ts` | `spawnBounded`（7）、`signalTree`（6） | 缺口；Windows 的 `taskkill` 分支只有 Windows CI 能覆盖 |
| `live.ts` | `mirrorGitWorkingState`（4）、`removeLease`（4） | 缺口 |
| `retry.ts` | `retryTransientBridge`（6） | 缺口 |
| `verifier.ts` | `contentText`（9） | 缺口 |

还没有覆盖的场景（不是行覆盖率能看出来的）：delivery-audit 的测试命令在真实 pwsh 下的行为；`danger-full-access` 分支的端到端行为；Windows 上的孙进程回收（R4 的残余风险）。

## 6. Windows CI（6.5）

`ci.yml` 新增 `test-windows`：`windows-latest`、Node 22、Python 3.11，步骤为 `check:architecture`、`check:contract`、`bash scripts/build.sh`、全部测试、`self_test.py`。它设了 `continue-on-error: true`，只报告、不阻断，在失败清理干净之前不会让 PR 变红。另外两项改动让结果可读：测试失败通过注解报告（日志存储在沙箱里经常无法访问）；报告器最后再发一条 warning 列出全部失败测试，因为 GitHub 每个步骤最多保留 10 条 error 注解。

| 轮次 | 提交 | 失败 | 原因 | 处置 |
|---|---|---|---|---|
| 1 | `316b37e` | 10 条以上（注解上限） | 几乎全是 `source-cwd-outside-git-root`：8.3 短名 | 6.5b |
| 2 | `8bb1342` | 8 条可见 | git 的 CRLF 警告混进数据（6.5a）；两个测试用短名路径和 git 的长路径比较；一个测试和 ledger 追加竞争 | 6.5a；测试改为比较规范路径；改用 `waitFor` 等待 ledger 行 |
| 3 | `6d6d87c` | **0** | push 和 pull_request 两次运行都全部通过：构建、329 个测试（检查 shell 为 pwsh）、`self_test.py` | — |

三轮之后，Windows 从“从未测过”变为全部通过，过程中找到并修复了两个只在真实环境里才会出现的产品缺陷（6.5a、6.5b）。

矩阵设计：

| 维度 | 取值 | 理由 |
|---|---|---|
| OS | `ubuntu-latest`（阻断）、`windows-latest`（失败清零之前只观察） | 生产环境是 Windows；Ubuntu 是现在的基线 |
| Node | 22 | 和 DSH 一致；DSH 升级时再加一列 |
| 检查 shell | pwsh（Windows runner 自带）、bash | `checks.ts` 的 shell 选择链 |
| 路径 | runner 的 TEMP 本身就是 8.3 短名；测试里用 junction 制造别名 | 6.5b |
| git | Git for Windows 默认配置（`core.autocrlf=true`） | 6.5a；Linux 上用 `GIT_CONFIG_COUNT` 复现同样的配置 |

转为阻断的条件：连续三个提交的运行都通过，并且注解里没有 `failed tests` warning。到那时把 `continue-on-error` 改为 false。`6d6d87c` 是第一个全部通过的提交；R8 收口时确认后续提交仍然通过，然后转为阻断。

## 7. 修复前后的行为证据

| 证据 | 修复前 | 现在 |
|---|---|---|
| `build-contract.test.mjs`（7 个） | 1/7（只有 bundle 等价性测试通过，它是防漂移的守卫）：两个取消原因测试、`build.sh` 委托、6.3 缺省值、6.4 `"abc"` 返回 202、CI 接线都失败 | 7/7 |
| `check:contract` 对 `d10fec4` 的源码 | 失败（`cancel()` 的参数不满足 DSH 的取消原因类型） | 通过 |
| `coverage-gaps`：别名路径（junction/符号链接） | `source-cwd-outside-git-root` | 通过 |
| `coverage-gaps`：`core.autocrlf=true` 下的 git 证据 | 失败（指纹相同、计数错误） | 通过 |
| 类型断言棘轮 | 不存在 | 新增一处会被列出位置并失败；基线偏高也会失败（两个方向都实测过） |
| Windows CI | 不存在 | 第 1 轮 10 条以上失败，第 3 轮 0 失败（§6） |

## 8. 决策表

| 事项 | 本轮做法 | 需要负责人决定的 |
|---|---|---|
| 6.3b `OPERATOR_BRIDGE_VENV_PYTHON` | 不改 | 推荐改为配置项或环境变量（`DSH_VA_PYTHON` 已经存在，可以只保留它），去掉硬编码的 `D:/` 路径 |
| 6.6b peer 依赖 | 保留，用类型契约赋予意义 | 无 |
| 6.1 拆分 | 只做设计 | 是否按 §4 的顺序在 R8 之后实施 |
| Windows 任务 | 只观察 | 何时转为阻断（推荐按 §6 的条件） |
| 回退构建 | 保留 | 是否在发布流程中禁止回退构建 |

## 9. 残余风险

- Windows 上 `taskkill` 回收进程树、pwsh 的 delivery-audit 测试命令，只有 Windows CI 能验证，目前是“只观察”。
- 6.5a 修复的是本插件读取 git 的方式。用户自定义的 check 命令仍然合并 stdout 和 stderr，这是有意的：check 的输出是给人看的。
- 类型断言棘轮只统计从 `unknown`/`any` 断言的情况；放宽类断言（29 处）仍然依赖代码审查。
- 回退构建依赖负责人机器上的路径。这条路径现在由 CI 覆盖，但 CI 用的是锁文件里的依赖版本，不是那些机器上的版本。

## 10. 兼容性影响

- P 的缺省值统一为 0（与配置一致）。只有直接调用 runner 或 bridge、又不传 P 的嵌入方会受影响（以前是 1）；标准 select 帧随之更新，sidecar 不需要改。
- `/select` 中类型错误的数值字段从 202 变为 400 `numeric-field-invalid`。
- 取消候选时现在带原因。DSH 的旧版本忽略这个参数，新版本正常结束 turn。
- `build.sh` 在装有 `node_modules` 时的行为变了（改为执行 CI 的命令，也不再替换已安装的包）；没有 `node_modules` 的机器不受影响。
- Windows 上的选择：通过 8.3 短名、junction 或符号链接给出的源路径现在可以用；git 证据（指纹、计数、采纳、审计补丁）的结果会和以前不同，现在的结果是正确的。

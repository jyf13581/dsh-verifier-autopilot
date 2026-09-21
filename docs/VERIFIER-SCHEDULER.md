# Verifier 调度恒等式（llm_verifier select 调用数）

2026-09-10 落定。回答悬案「usage.calls / nComparisons 的比值在 1x 到 6.4x
之间不规律」——现代链路上它是确定性的公式，不是未知行为。

## 公式（源码级依据）

上游 `D:/tools/llm-as-a-verifier-main`（本机只读参考树，不是生成实现）：

- `pivot_tournament.py select_best()`：比较对 = ring（恰好 N 个有向相邻对）
  + pivot rounds（`(N-k)*k + C(k,2)` 对有向对，`k = min(pivots, N)`）。
  `n_comparisons = N + (N-k)*k + C(k,2)`。
- `__init__.py select()`：先跑 ring（Phase A）再跑 pivot（Phase B），
  两轮分别走 `score_directed_pairs(...)`。
- `fine_grained_reward.py score_directed_pairs()`：每个有向对展开成
  `|criteria| × n_evaluations` 个 job，**每个 job 恰好一次 API 调用**；
  运行内无重试（失败在 `on_error='tie'` 下记 0.5/0.5 并消耗这一个调用，
  `'raise'` 下整轮中止）。job 数即调用数（缓存命中除外，侧车用每轮全新
  temp cache，因此从不命中）。

因此恒等式：

```
nComparisons = N + (N - k) * k + C(k, 2)        # k = min(pivots, N)
usage.calls  = nComparisons * criteriaCount * effectiveEvaluations
```

## 当前自动路径代入值

autopilot 固定 `DEFAULT_CRITERIA`（task_fidelity / correctness_evidence /
integration_quality）→ **criteriaCount = 3**；manual /select 缺省
`safeCriteria()` → 单条 `{correctness}`（C=1）；显式 criteria 按实计。

| N | P | K | C | nComparisons | expected calls |
|---|---|---|---|--------------|----------------|
| 2 | 0 | 1 | 3 | 2 | 6 |
| 2 | 1 | 1 | 3 | 3 | 9 |
| 2 | 2 | 1 | 3 | 3 | 9 |
| 3 | 1 | 2 | 3 | 5 | 30 |
| 3 | 2 | 2 | 3 | 6 | 36 |

（C=1 的 manual 场景：calls 列即 nComparisons×K。）

## 已核验的 live 证据

- sel-cd6590de / sel-1b5c286c（manual，N=2 P=0 K=1，C=1 单准则）：
  nComparisons=2、calls=2 —— 恒等式精确成立（1.0x）。
- 任何现代记录（2026-09-05 之后属严格校验时代）都满足恒等式，
  除非侧车/上游行为改变。

## 历史 1.33x–6.4x 的口径判定（2026-09-04 的 8 条旧记录）

sel-290185b9（nc3/calls4）、sel-4fcbc905（nc3/4）、sel-8d778422（nc3/4*）、
sel-3699fb1c（nc5/8）等：**不可从 ledger 字段复原分解**——旧格式不记
criteria/pivots/有效 K，bridge 又有 `n_evaluations ?? 4` 的兼容 fallback，
且旧侧车的 on_error 口径未经考证。比值非整数（3→4、5→8、5→32）意味着
当时存在「比较对之间不均匀的额外调用」，与现代 `on_error='raise'` 链路的
结构不同。结论：这批数字属于旧运行时制品，不再往回挖；恒等式从写入
`criteriaCount`/`expectedVerifierCalls` 起（commit 32a67ed）让任何未来的
偏差当场可见、不再依赖考古。

## 守门规则

- ranking record 必须同时落 `criteriaCount`、`expectedVerifierCalls`
  （candidates.ts，ranking 成功分支写入；ledger append 语义自然携带）。
- 读 ledger 时：`usage.calls != expectedVerifierCalls` 即为异常信号
  （上游调度变了、计数器漏了、或 tie 吞调用回归）。
- preflight 与 progressGuard 的调用走独立 frame/独立 usage，
  不进入本条恒等式。

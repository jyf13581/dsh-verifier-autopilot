# Margin gate 毕业条件单（max-with-margin 上线 invoice）

2026-09-10 起草本单。对象：`selectionMarginThreshold`（当前 0.03）从
`marginProvisional=true` 转为正式上线的**条件清单**；同时记录为什么
ruling I.4 原定的「两轮 q95 相差 < 20%」在可承受样本量下永远毕不了业。

## 诊断：q95 跨轮 20% 准则不可达（统计结构问题）

同条件 `kimi-k3@low` 已有四轮（C0 帧=自比较零假设）：

| 轮次 | C0 n | q95 | max | C1 | C2 | 跨轮 q95 相对差 |
|---|---|---|---|---|---|---|
| round2 | 40 | 0.01023 | 0.01377 | 12/12 | 12/12 | — |
| round3 | 40 | 0.00130 | 0.00536 | 12/12 | 12/12 | 87% ✗ |
| round4 | 60 | 0.00535 | 0.01308 | 12/12 | 12/12 | 311% ✗ |
| round5 | 100 | 0.00854 | 0.01120 | 12/12 | 12/12 | +59.4% ✗（n=100 仍败） |

q95 在 n=40–60 下是尾部第 1–3 个次序统计量，天然带 ±1 个量级内的抽样
噪声；0.0013 ↔ 0.0102 的摆动就是估计器自身噪声，不是噪声本体的移动。
**round5 用 n=100 正式坐实这条诊断**：q95 跨轮相对差仍有 +59.4% ——
n 翻 2.5 倍并没有让它进 20%，因此「两轮 q95 一致」在任何可承受样本量
下都不是可达毕业条件，原 I.4 准则据此正式退役。

真正稳定穿过五轮两个模型家族（kimi-k3、minimax-m3）的量是**经验噪声
ceiling（max）**：

```
5 轮 C0 max: 0.01377 / 0.00536 / 0.01308 / 0.01120 / （m3 轮: 全部失败作废不计）
恒 ≤ 0.014；0.03 / 0.01377 = 2.17x（早前「≥2.2x」为向上取整的轻微高估，
2026-09-10 复核纠正）。
round5 正直性证据：124 calls / 0 failures / callsTotal 200 for C0（每帧 nc=2、
  calls=2 —— 与 docs/VERIFIER-SCHEDULER.md 恒等式逐帧吻合）
```

## 毕业规则（替换 I.4 的 gating 统计量）

以 **max-with-margin** 为准则毕业：

1. C0：同条件累计 ≥ 300 帧、跨 ≥ 3 个相互独立轮次、≥ 2 个自然日；
   每一轮的 C0 `max` ≤ `0.02`（给 0.03 留 ≥1.5x 余量），累计 max
   与当前 threshold 的比值 ≤ 1/2.0。
2. C1：最近一轮 12/12 方向正确（一个错误即本轮整体作废重跑）。
3. C2：最近一轮 ≥ 11/12，且任何错误方向帧的 margin 必须 ≤ 门限一半
   （即错误方向只许出现在噪声带内，不许在深区反向）。
4. 位置偏置：同轮 C0 `positionalBiasMean` 的绝对值 ≤ 0.005。
5. 以上全部满足后，`marginProvisional=false` 与 threshold 一起写入代码
   常量与 HANDOFF；任何一条不满足则继续 provisional 并在本单记账。

## 当前评估（round5 落地后，2026-09-10 15:56 本地）

| # | 条件 | 状态 |
|---|---|---|
| 1 | C0 累计 ≥300 帧（kimi-k3@low：40+40+60+100=**240**，差 60）；每轮 max ≤0.02 ✓（0.01377/0.00536/0.01308/0.01120）；≥2 个自然日 ✗（round2–5 全在 2026-09-10 当天） | **未达** |
| 2 | C1 最近一轮 12/12 | ✓（round5） |
| 3 | C2 ≥11/12 | ✓（round5 12/12，min margin 0.385，深区无反向） |
| 4 | 位置偏置 ≤0.005 | ✓（round5 bias=0.00036；历史轮 0.001 档） |

**结论：marginProvisional 继续保持 true。** 判定执行器：
`node eval/calibration/graduate.mjs [condition]`（离线读 `.data/calibration`
汇总，输出逐条 PASS/FAIL + GRADUATE/HOLD/RETHRESHOLD 与退出码；毕业生成
前不再手算）。缺口具体且小：
round6 补 ≥60 C0 帧 + 至少一轮落在与 round2–5 不同的自然日即满足
条件 1；其余条件已被最近一轮满足。补跑即用现成命令：
`CAL_MODEL=kimi-k3 CAL_EFFORT=low CAL_C0_REPS=12 CAL_LABEL=round6 node eval/calibration/run.mjs`。

**升级护栏**（防毕业前阈值被侵蚀）：若任何一轮 C0 max > 0.015，
则 0.03 与 2.2x 安全倍率的乘积关系被破坏（0.015 × 2.2 = 0.033 > 0.03），
届时正确动作是重估 threshold 而不是翻毕业开关。当前累计 max=0.01377，
安全倍率 2.17，贴近但仍 ≥2；保持阈值不动。

## 上线后语义

`max-with-margin 准则`= 现行 margin gate 的正式版：top-2 margin ≥ 阈值
才允许 `outcome=ranked_winner`，否则 `abstain`。毕业时**不改行为**，
只摘掉 provisional 标。

## 剩余已知风险（不挡毕业，但记账）

- q95 作为描述性统计继续上 report，不再担任何闸门职责。
- 换 verifier 模型/端点/effort 任一项 → 条件集合重新累计（condition
  串已落在每条 record 的 `marginCondition`）。
- `abstain` 密度运营体检（abstain 占比长期 >30% 说明 margin gate 与真实
  分布错位）尚未有数据，需运营观察而非校准补。

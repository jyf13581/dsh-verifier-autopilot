# Repair-v2 实验预注册

> 状态：历史预注册，**未消耗任何实弹配额**。本文档属于旧的 verifier feedback repair-v2 路线，不是当前 DSH best-of-N candidate selection 目标。当前交接明确不执行本实验；不得把本文指标、210/300 预算或旧 feedback 结果当作新 selector 验收。
> 执行后只允许追加"偏差记录"章节，不得回改指标定义。
> 日期：2026-08-26　工具基线：eval/repair-v2.mjs @ 本提交　关联：HANDOFF.md §7「旧工作分类」

## 1. 目标问题

量化 verifier 反馈闭环的真实价值：反馈在什么触发率下出现、修复是否真的有效、干净场景被误扰的比例、以及修复是否引入回归。取代阶段 4 的单点偶然观察。

## 2. 被试与循环定义

- **被试**：指定的弱模型（候选从 provider 目录选取非旗舰档；正式跑前锁定并记录模型 id）。
- **最小 agent 循环**：输入 = 场景 problem + files；允许动作 = 编辑文件、运行 `node checks/*.check.js`；步数 ≤ 12，总时长 ≤ 10 分钟/轮。系统提示不得包含本实验任何约束（不泄漏规则由测试套件锁定）。
- **修复轮输入**：verifier 反馈全文（与生产 followup 文本一致），不附加解释。

## 3. 场景

`generateScenarios({ seed: 7, defectCount: 20, cleanCount: 10 })`，一次生成、落盘存档、全程复用同一份。约束不泄漏由 scripts/test.mjs 锁定；独立 node checks 提供 repairValid/regressed 的客观判定依据。

## 4. 指标（与 computeRepairMetrics 公式逐字一致）

| 指标 | 定义 | 分母 |
| --- | --- | --- |
| 触发率 triggerRate | 五路验证 shouldRequestFeedback=true 的 defect 场景数 | 全部 defect 场景 |
| 无效打扰率 nuisanceRate | triggered=true 的 clean 场景数 | 全部 clean 场景 |
| 有效修复率 validRepairRate | repairValid=true 的已修复 defect 数 | 已发起修复(repaired) 的 defect 数 |
| 回归率 regressionRate | regressed=true 的已修复 defect 数 | 已发起修复的 defect 数 |

repairValid ⟺ 修复轮复验 status='completed' 且 mean ≥ 0.62 且 dispersion ≤ 0.12 且全部 checks 退出码 0。
regressed ⟺ 任一原本通过的 check 转为失败，或复验出现引用了有效证据的新 defect finding。
零分母输出 null（不报 0%）。

## 5. 流程（每个场景）

1. subject 初始轮 → 产物落盘。
2. 生产路径五路验证（routes=5）→ 记录 triggered / aggregate。
3. triggered 且 kind=defect → 反馈回灌 → 修复轮 → 复验 + checks → 记录 repaired/repairValid/regressed。
4. clean 场景仅步骤 1-2，triggered 即计打扰。

## 6. 样本量与预算

20 defect + 10 clean；预计 lane 请求 ≈ 30×5 + 修复轮 ≈ 12×5 ≈ **210**，硬顶 **300**。达到硬顶立即收尾并按已完成样本出报告。

## 7. 止损规则

连续 3 个 defect 场景零触发 → 停止，归因方向：(a) 被试过强未落入陷阱；(b) 场景失效；(c) 验证器阈值不适配该被试档位。

## 8. 分析计划

只报告上表四指标 + 逐例归因文件（每行含 scenarioId/labels/findings/checks 结果）。任何偏离本文件的执行差异必须在报告"偏差记录"中显式列出。历史阶段 4 数字（4/4、0/3）是管线验收，不作为本实验对照基线。

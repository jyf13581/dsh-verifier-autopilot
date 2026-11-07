// Review R7 7.2: representative first messages of a DSH coding session,
// labelled by what a reasonable operator wants from them -- chat: nothing;
// question: an answer, no rollouts; trivial: one obvious small edit;
// substantive: open-ended work where independent attempts can differ in
// quality. The autopilot admission heuristic is characterized against this
// set (scripts/tests/product-defaults.test.mjs), so a policy change shows up
// as a diff in the pinned profile rather than as an unmeasured feeling.
// Labels are deliberately conservative; add cases, do not relabel to fit.
export const ADMISSION_CORPUS = {
  chat: [
    "thanks", "继续", "ok", "好的，谢谢", "hi", "下一步", "status?", "looks good", "nice, that worked", "收到",
  ],
  question: [
    "What does the retry helper in src/selection/retry.ts do?",
    "Explain how the margin gate works.",
    "Why is the test suite slow?",
    "How do I run the tests for just one file?",
    "Which config option controls the number of candidates?",
    "这个仓库的代码结构是怎样的？",
    "What is the difference between release and discard?",
    "解释一下 ledger 的掉电语义",
    "Is there an API to list selections?",
    "Can you review this approach before I start? I want to cache probe results per model for 30 minutes.",
  ],
  trivial: [
    "Fix the typo \"recieve\" in README.md",
    "Rename the variable tmp to tempDir in scripts/build.sh",
    "Add a trailing newline to package.json",
    "Bump the version in package.json to 0.3.1",
    "把 README 里的 “Kimi” 改成 “kimi”",
    "Remove the unused import in src/util.ts",
    "Change the default port in the example from 3000 to 3080",
    "Add a .gitignore entry for coverage/",
    "Update the copyright year in LICENSE",
    "删除 src/api.ts 里多余的 console.log",
  ],
  substantive: [
    "Implement rate limiting for the /select endpoint with a sliding window and tests.",
    "Refactor SelectionRunner.run into smaller phase functions without changing behavior.",
    "Debug why candidate worktrees leak on Windows when the source agent is aborted.",
    "Add a --json flag to eval/run.mjs that writes machine-readable results, with tests.",
    "实现一个按模型缓存探活结果的功能，30 分钟过期，并补测试",
    "Migrate the ledger from JSONL to SQLite while keeping the read API stable.",
    "Investigate the flaky lifecycle test and fix the root cause.",
    "给 /state 接口加上鉴权，并更新前端调用和测试",
    "Optimize gitDiffStat for repositories with 10k untracked files.",
    "Write an end-to-end test for the autopilot relay path using the fake factory.",
  ],
}

// Real Git repositories under a temp directory for workspace tests.
// Shared by scripts/tests/*.test.mjs; import what you use, every export is a
// plain function or value with no registration side effects.

import { mkdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"

export function runGit(cwd, ...args) {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim()
}

export function makeGitRepo(parent, name) {
  const repo = path.join(parent, name)
  mkdirSync(path.join(repo, "src"), { recursive: true })
  runGit(repo, "init", "-q")
  runGit(repo, "config", "user.email", "autopilot-test@example.invalid")
  runGit(repo, "config", "user.name", "Autopilot Test")
  writeFileSync(path.join(repo, "tracked.txt"), "tracked-base\n")
  writeFileSync(path.join(repo, "staged.txt"), "staged-base\n")
  writeFileSync(path.join(repo, "src", "entry.ts"), "export const value = 1\n")
  runGit(repo, "add", ".")
  runGit(repo, "commit", "-qm", "fixture")
  return repo
}

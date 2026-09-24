// Bridge construction against the stub sidecar
// (scripts/tests/fixtures/stub_sidecar.py) or the real one, offline.
// Shared by scripts/tests/*.test.mjs; import what you use, every export is a
// plain function or value with no registration side effects.

import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"
import { VerifierBridge } from "../../../lib/selection/bridge.js"

/** Canonical protocol frames (bridge/protocol-fixtures.json): what the bridge
 *  must send, what the stub answers, what the real sidecar must satisfy. */
export const PROTOCOL = JSON.parse(readFileSync(new URL("../../../bridge/protocol-fixtures.json", import.meta.url), "utf8"))

export const BRIDGE_PY = process.env.DSH_VA_PYTHON
  || (process.platform === "win32" ? "D:/tools/pyvenvs/llm-verifier-bridge/Scripts/python.exe" : "python3")

export const STUB_SIDECAR = fileURLToPath(new URL("../fixtures/stub_sidecar.py", import.meta.url))

export const REAL_SIDECAR = fileURLToPath(new URL("../../../bridge/llm_verifier_sidecar.py", import.meta.url))

export function mkBridge(scriptPath, opts = {}) {
  return new VerifierBridge({
    pythonPath: BRIDGE_PY,
    scriptPath,
    shutdownGraceMs: 300,
    ...opts,
  })
}

export const bridgeReq = (over = {}) => ({
  problem: "demo pair",
  candidates: ["cand-0", "cand-1"],
  criteria: { c1: "demo criterion" },
  model: "m", baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "dummy", apiKeyEnv: "SMOKE_KEY",
  ...over,
})

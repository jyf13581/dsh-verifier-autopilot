// Mocked verifier provider: fetch stubs, configs, credentials, score-tag bodies,
// and lane response builders.
// Shared by scripts/tests/*.test.mjs; import what you use, every export is a
// plain function or value with no registration side effects.

import { LF } from "./harness.mjs"

export function letterDistribution(letter, competitors) {
  return [{ token: letter, logprob: Math.log(0.7) }].concat(competitors.filter(c => c !== letter).map(c => ({ token: c, logprob: Math.log(0.15) })))
}

export function scorePositions() {
  const tokens = ["<score_A>", " K ", "</score_A>", LF, "<score_B>", " M ", "</score_B>"]
  return tokens.map((token, index) => ({ token, top_logprobs: index === 1 ? letterDistribution("K", ["T", "J"]) : index === 5 ? letterDistribution("M", ["T", "J"]) : [] }))
}

export const testConfig = { apiKeyEnv: "TEST_KEY", baseURL: "http://mock.local/v1", model: "mock", routes: 5, maxTokens: 512, temperature: 0.2, timeoutMs: 1000, scoreThreshold: 0.62, disagreementThreshold: 0.12 }

export const testCredentials = { resolve: async () => ({ value: "mock-key" }) }

export const successBody = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: ["Analysis.", "finding: no concrete defect found", "<score_A> A </score_A>", "<score_B> B </score_B>"].join(LF) }, logprobs: { content: scorePositions() } }] }

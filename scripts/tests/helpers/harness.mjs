// Timing and failure-observation primitives shared by every test file.
// Shared by scripts/tests/*.test.mjs; import what you use, every export is a
// plain function or value with no registration side effects except the
// unhandled-rejection collector, which is installed on import.

export const LF = String.fromCharCode(10)

// Phase 0 guard: accidental unhandled rejections become observable data instead
// of a crashed runner. Individual phase-0 tests assert on this list.
export const unhandledRejections = []

// Stray rejections become data a test can assert on AND a failed file: the
// collector prints the reason and marks the process, so a leak no test asserts
// on still fails the run instead of being swallowed.
process.on("unhandledRejection", reason => {
  unhandledRejections.push(reason)
  console.error("unhandled rejection in test file:", reason)
  process.exitCode = 1
})

export const quiesce = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

export function deferred() {
  let resolve
  let reject
  // Hold a live timer while the gate is pending: mocked lanes have no socket
  // handles, so without this the event loop could drain mid-await and the test
  // runner would cancel the suite. Cleared on settle for clean shutdown.
  const holder = setTimeout(() => {}, 60000)
  const promise = new Promise((res, rej) => {
    resolve = value => { clearTimeout(holder); res(value) }
    reject = error => { clearTimeout(holder); rej(error) }
  })
  return { promise, resolve: resolve, reject: reject }
}

export async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error("waitFor-timeout")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

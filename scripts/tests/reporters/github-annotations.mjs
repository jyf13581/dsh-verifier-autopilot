// node:test reporter that turns each failing test into a GitHub Actions
// `::error` annotation. Annotations are served by the checks API and shown on
// the PR, so a failure is readable even where raw job logs are not (log blob
// storage is often unreachable from sandboxes and API clients). CI runs it next
// to the spec reporter; locally `npm test` is unchanged.

const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
const escapeProp = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C")

export default async function* githubAnnotations(source) {
  for await (const event of source) {
    if (event.type !== "test:fail") continue
    const data = event.data ?? {}
    const error = data.details?.error
    // Suites fail when a child fails; the child already carries the reason.
    if (error?.failureType === "subtestsFailed") continue
    const cause = error?.cause ?? error
    const message = [data.name, cause?.message ?? String(cause ?? "failed"), cause?.stack?.split("\n").slice(1, 6).join("\n")]
      .filter(Boolean).join("\n").slice(0, 3000)
    const file = typeof data.file === "string" ? data.file.replace(/^file:\/\//, "").replace(process.cwd() + "/", "") : ""
    const props = [file && "file=" + escapeProp(file), data.line && "line=" + data.line, "title=" + escapeProp("test failed: " + data.name)].filter(Boolean).join(",")
    yield "::error " + props + "::" + escapeData(message) + "\n"
  }
}

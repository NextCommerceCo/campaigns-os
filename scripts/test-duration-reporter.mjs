// A node:test reporter that sums each test file's top-level test durations and
// writes them as one JSON object, absolute path -> milliseconds. Top-level
// tests in a file run one after another, so the sum is close to the file's run
// time. check-tests.mjs uses it for --record-durations.
export default async function* durationReporter(source) {
  const perFile = {};
  for await (const event of source) {
    if ((event.type === "test:pass" || event.type === "test:fail") && event.data.nesting === 0 && event.data.file) {
      perFile[event.data.file] = (perFile[event.data.file] ?? 0) + (event.data.details?.duration_ms ?? 0);
    }
  }
  yield JSON.stringify(perFile);
}

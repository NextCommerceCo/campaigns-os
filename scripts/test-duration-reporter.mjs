// A node:test reporter that writes how long each test file ran, as one JSON
// object: absolute path -> milliseconds. The runner reports every file as a
// test of its own, named by the file's path, and completes it when the file's
// process exits, so that duration covers the process's start-up and imports,
// every test and the teardown. Summing a file's top-level tests would leave
// out everything but the tests, which is most of what a file of quick tests
// costs. Nor can a reporter time a file from its tests' events: the first
// comes only after the file's imports, and the runner holds a file's results
// back until every file started before it has reported, so a quick file's
// results can all arrive at once, long after it ran.
// check-tests.mjs uses it for --record-durations.
import { resolve } from "node:path";

export default async function* durationReporter(source) {
  const perFile = {};
  for await (const event of source) {
    const { name, nesting, file, details } = event.data ?? {};
    if (event.type === "test:complete" && nesting === 0 && file && resolve(name) === file) {
      perFile[file] = details?.duration_ms ?? 0;
    }
  }
  yield JSON.stringify(perFile);
}

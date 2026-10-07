#!/usr/bin/env node
// Runs test files with node:test, starting them in the order given.
// check-tests.mjs runs every lane through it, slowest files first: `node --test`
// sorts its files by path before it starts any, so a long file that sorts late
// starts late and sets the lane's end. Otherwise the files run as under
// `node --test`: each in its own process, as many at once as there are CPUs
// less one, reported by the spec reporter, and the exit code is 1 when a test
// fails. `--durations=<path>` also writes each file's run time to <path> (see
// test-duration-reporter.mjs).
import { createWriteStream } from "node:fs";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import durationReporter from "./test-duration-reporter.mjs";

const DURATIONS = "--durations=";
const args = process.argv.slice(2);
const durationsPath = args.find((arg) => arg.startsWith(DURATIONS))?.slice(DURATIONS.length);
const files = args.filter((arg) => !arg.startsWith(DURATIONS));

const results = run({ files, concurrency: true });
// The failure rules `node --test` applies: Node 22 and later fail a run whose
// summary reports failure, and Node 20, which sends no summary, fails on any
// failed test that is not a todo.
results.on("test:summary", (data) => {
  if (!data.success) process.exitCode = 1;
});
results.on("test:fail", (data) => {
  if (data.todo === undefined || data.todo === false) process.exitCode = 1;
});
results.compose(new spec()).pipe(process.stdout);
if (durationsPath) results.compose(durationReporter).pipe(createWriteStream(durationsPath));

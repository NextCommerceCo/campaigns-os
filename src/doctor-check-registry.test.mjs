import assert from "node:assert/strict";
import test from "node:test";
import {
  createDoctorCheckRegistry,
  runDoctorCheckRegistry,
} from "./doctor-check-registry.mjs";

test("doctor check registry runs named checks in declared order", () => {
  const calls = [];
  const registry = createDoctorCheckRegistry([
    {
      id: "packet.shape",
      phase: "packet",
      run: ({ issue }) => {
        calls.push("packet.shape");
        issue("packet checked");
      },
    },
    {
      id: "spec.routes",
      phase: "spec",
      when: ({ spec }) => Boolean(spec),
      run: ({ issue }) => {
        calls.push("spec.routes");
        issue("spec checked");
      },
    },
  ]);
  const issues = [];

  const executed = runDoctorCheckRegistry(registry, {
    spec: { id: "spec" },
    issue: (message) => issues.push(message),
  });

  assert.deepEqual(executed, ["packet.shape", "spec.routes"]);
  assert.deepEqual(calls, ["packet.shape", "spec.routes"]);
  assert.deepEqual(issues, ["packet checked", "spec checked"]);
});

test("doctor check registry skips checks whose predicate is false", () => {
  const registry = createDoctorCheckRegistry([
    {
      id: "spec.routes",
      phase: "spec",
      when: ({ spec }) => Boolean(spec),
      run: () => {
        throw new Error("should not run without a spec");
      },
    },
  ]);

  assert.deepEqual(runDoctorCheckRegistry(registry, { spec: null }), []);
});

test("doctor check registry rejects duplicate ids", () => {
  assert.throws(
    () => createDoctorCheckRegistry([
      { id: "spec.routes", run: () => {} },
      { id: "spec.routes", run: () => {} },
    ], { registryId: "packet" }),
    /duplicate check id "spec.routes"/
  );
});

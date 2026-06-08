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

test("doctor check registry can run only checks in a requested phase", () => {
  const calls = [];
  const registry = createDoctorCheckRegistry([
    {
      id: "packet.shape",
      phase: "packet",
      run: () => calls.push("packet.shape"),
    },
    {
      id: "spec.routes",
      phase: "spec",
      run: () => calls.push("spec.routes"),
    },
  ]);

  assert.deepEqual(runDoctorCheckRegistry(registry, {}, { phase: "spec" }), ["spec.routes"]);
  assert.deepEqual(calls, ["spec.routes"]);
});

test("doctor check registry treats blank phase filters as unfiltered", () => {
  const registry = createDoctorCheckRegistry([
    { id: "packet.shape", phase: "packet", run: () => {} },
    { id: "spec.routes", phase: "spec", run: () => {} },
  ]);

  assert.deepEqual(runDoctorCheckRegistry(registry, {}, { phase: "" }), ["packet.shape", "spec.routes"]);
  assert.deepEqual(runDoctorCheckRegistry(registry, {}, { phase: "unknown" }), []);
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

test("doctor check registry rejects invalid registry inputs with registry ids", () => {
  assert.deepEqual(createDoctorCheckRegistry([], { registryId: "packet" }), []);
  assert.throws(
    () => createDoctorCheckRegistry(null, { registryId: "packet" }),
    /Doctor check registry "packet" must be an array/
  );
  assert.throws(
    () => createDoctorCheckRegistry([null], { registryId: "packet" }),
    /Doctor check registry "packet" has a non-object check at index 0/
  );
});

test("doctor check registry rejects invalid check fields with registry ids", () => {
  assert.throws(
    () => createDoctorCheckRegistry([{ id: " ", run: () => {} }], { registryId: "packet" }),
    /Doctor check registry "packet" check at index 0 needs a non-empty id/
  );
  assert.throws(
    () => createDoctorCheckRegistry([{ id: "spec.routes", phase: " ", run: () => {} }], { registryId: "packet" }),
    /Doctor check registry "packet" check "spec.routes" needs a phase/
  );
  assert.throws(
    () => createDoctorCheckRegistry([{ id: " spec.routes " }], { registryId: "packet" }),
    /Doctor check registry "packet" check "spec.routes" needs a run function/
  );
  assert.throws(
    () => createDoctorCheckRegistry([{ id: "spec.routes" }], { registryId: "packet" }),
    /Doctor check registry "packet" check "spec.routes" needs a run function/
  );
  assert.throws(
    () => createDoctorCheckRegistry([{ id: "spec.routes", run: () => {}, when: true }], { registryId: "packet" }),
    /Doctor check registry "packet" check "spec.routes" has a non-function when predicate/
  );
});

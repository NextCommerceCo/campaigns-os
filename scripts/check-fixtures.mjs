#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const cli = resolve(root, "bin/campaigns-os.mjs");
const packet = resolve(root, "examples/build-packet.basic.json");

if (!existsSync(packet)) {
  throw new Error(`Missing fixture packet: ${packet}`);
}

execFileSync(process.execPath, [cli, "doctor", "--packet", packet, "--json"], {
  cwd: root,
  stdio: "pipe",
  env: { ...process.env, CAMPAIGNS_API_KEY: "fixture-key" },
});

execFileSync(process.execPath, [cli, "next", "build", "--packet", packet, "--json"], {
  cwd: root,
  stdio: "pipe",
  env: { ...process.env, CAMPAIGNS_API_KEY: "fixture-key" },
});

execFileSync(process.execPath, [cli, "qa", "resolve", "--packet", packet, "--json"], {
  cwd: root,
  stdio: "pipe",
  env: { ...process.env, CAMPAIGNS_API_KEY: "fixture-key" },
});

console.log("Fixture checks passed");

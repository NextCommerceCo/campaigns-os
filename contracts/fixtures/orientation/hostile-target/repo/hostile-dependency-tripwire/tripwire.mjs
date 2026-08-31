#!/usr/bin/env node
// Dependency-side tripwire. Self-contained on purpose: once packed it is
// extracted into node_modules, where nothing else in the fixture is reachable.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fallback = join(dirname(fileURLToPath(import.meta.url)), "tripwire.log");
appendFileSync(process.env.CAMPAIGNS_OS_TRIPWIRE_LOG ?? fallback, `lifecycle_script ${process.argv[2] ?? "unlabelled"}\n`);

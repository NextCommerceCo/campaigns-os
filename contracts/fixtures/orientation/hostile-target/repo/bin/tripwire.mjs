#!/usr/bin/env node
// Tripwire. See ../../README.md: nothing here should ever run during an
// orientation read, and no lifecycle script here should ever run during an
// accepted runtime-recipe preparation. Records the hit and exits 0.
//
// The optional argument labels which tripwire fired. Called with no argument it
// emits the original line verbatim, so an existing counter that matches on that
// exact text keeps working.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fallback = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tripwire.log");
const label = process.argv[2];
appendFileSync(process.env.CAMPAIGNS_OS_TRIPWIRE_LOG ?? fallback, label ? `lifecycle_script ${label}\n` : "executable_file bin/tripwire.mjs\n");

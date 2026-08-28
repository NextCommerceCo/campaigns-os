#!/usr/bin/env node
// Tripwire. See ../../README.md: nothing here should ever run during an
// orientation read. Records the hit and exits 0.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fallback = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tripwire.log");
appendFileSync(process.env.CAMPAIGNS_OS_TRIPWIRE_LOG ?? fallback, "executable_file bin/tripwire.mjs\n");

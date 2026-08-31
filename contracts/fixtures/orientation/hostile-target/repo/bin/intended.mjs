#!/usr/bin/env node
// NOT a tripwire. This is the one script an accepted runtime recipe's build step
// is supposed to run, and it writes to its own log so the two assertions stay
// separable: the lifecycle log must stay empty, and this log must have exactly
// one line. A fixture that only proved "nothing ran" would also pass if the
// build itself never ran.
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fallback = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "intended.log");
appendFileSync(process.env.CAMPAIGNS_OS_INTENDED_LOG ?? fallback, `intended_script ${process.argv[2] ?? "unlabelled"}\n`);

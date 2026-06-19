#!/usr/bin/env node

import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).catch((error) => {
  // Rewrite raw Node file-not-found errors (e.g. a mistyped --packet path) into
  // a message that names the path and the likely fix, instead of leaking the
  // bare `ENOENT: no such file or directory, open '...'` errno string.
  if (error && error.code === "ENOENT" && error.path) {
    console.error(
      `campaigns-os: file not found: ${error.path}. Check the path; ` +
        "run `campaigns-os start ...` first if you have not generated the packet yet.",
    );
    process.exit(1);
  }
  console.error(`campaigns-os: ${error.message}`);
  process.exit(1);
});

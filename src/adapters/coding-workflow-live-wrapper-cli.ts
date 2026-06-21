#!/usr/bin/env node

/**
 * CLI entrypoint used by the NGX-499 checked-in live-wrapper profile.
 *
 * Keep this adapter thin: behavior and test seams live in
 * `src/core/workflow/coding-workflow-live-wrapper.ts`; the executable wrapper
 * only runs the seam, mirrors an unsuccessful summary to stderr, and exits with
 * the seam's process status.
 */
import fs from "node:fs";

import { runCodingWorkflowLiveWrapper } from "../core/workflow/coding-workflow-live-wrapper.js";

const outcome = runCodingWorkflowLiveWrapper();
if (!outcome.success) {
  fs.writeSync(2, `${outcome.summary}\n`);
}
process.exitCode = outcome.exitCode;

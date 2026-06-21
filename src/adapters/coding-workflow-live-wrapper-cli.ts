#!/usr/bin/env node

import fs from "node:fs";

import { runCodingWorkflowLiveWrapper } from "../core/workflow/coding-workflow-live-wrapper.js";

const outcome = runCodingWorkflowLiveWrapper();
if (!outcome.success) {
  fs.writeSync(2, `${outcome.summary}\n`);
}
process.exitCode = outcome.exitCode;

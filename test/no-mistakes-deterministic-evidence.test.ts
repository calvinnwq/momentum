import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  classifyNoMistakesDeterministicEvidence,
  type NoMistakesEvidenceExpectedIdentity
} from "../src/core/workflow/recovery/no-mistakes-evidence.js";

const EXPECTED: NoMistakesEvidenceExpectedIdentity = {
  workflowRunId: "run-ngx-561",
  issueScope: ["NGX-561"],
  branch: {
    name: "feat/ngx-561-deterministic-no-mistakes-evidence",
    headSha: "1111111111111111111111111111111111111111"
  },
  pullRequest: {
    id: "193",
    headSha: "1111111111111111111111111111111111111111"
  },
  noMistakesRunId: "01KWHNGX561PASS000000000000"
};

function fixture(name: string): unknown {
  return JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), "test", "fixtures", name),
      "utf8"
    )
  ) as unknown;
}

describe("classifyNoMistakesDeterministicEvidence", () => {
  it("accepts complete current checks-passed evidence", () => {
    const out = classifyNoMistakesDeterministicEvidence(
      fixture("no-mistakes-evidence-clean-success.json"),
      EXPECTED
    );

    expect(out).toEqual({
      ok: true,
      noMistakesRunId: "01KWHNGX561PASS000000000000",
      evidencePointer:
        "no-mistakes:01KWHNGX561PASS000000000000#checks-passed",
      satisfiedPhases: [
        "review",
        "tests",
        "docs",
        "lint",
        "format",
        "push",
        "pr",
        "ci"
      ]
    });
  });

  it("refuses stale head SHA evidence", () => {
    const out = classifyNoMistakesDeterministicEvidence(
      fixture("no-mistakes-evidence-stale-head.json"),
      EXPECTED
    );

    expect(out).toMatchObject({ ok: false, reason: "head_mismatch" });
  });

  it("refuses missing required test phase evidence", () => {
    const out = classifyNoMistakesDeterministicEvidence(
      fixture("no-mistakes-evidence-missing-test-phase.json"),
      EXPECTED
    );

    expect(out).toMatchObject({ ok: false, reason: "partial" });
    if (!out.ok) expect(out.message).toContain("tests");
  });

  it("refuses evidence with unresolved review findings", () => {
    const out = classifyNoMistakesDeterministicEvidence(
      fixture("no-mistakes-evidence-review-finding.json"),
      EXPECTED
    );

    expect(out).toMatchObject({
      ok: false,
      reason: "review_findings_present"
    });
  });

  it("refuses mismatched pull request evidence", () => {
    const out = classifyNoMistakesDeterministicEvidence(
      fixture("no-mistakes-evidence-pr-mismatch.json"),
      EXPECTED
    );

    expect(out).toMatchObject({
      ok: false,
      reason: "pull_request_mismatch"
    });
  });

  it("refuses closed pull request evidence", () => {
    const evidence = fixture("no-mistakes-evidence-clean-success.json") as {
      pullRequest: { state: string };
    };
    evidence.pullRequest.state = "closed";

    const out = classifyNoMistakesDeterministicEvidence(evidence, EXPECTED);

    expect(out).toMatchObject({
      ok: false,
      reason: "failed_or_pending_checks"
    });
  });

  it("refuses internally mismatched pull request head evidence", () => {
    const evidence = fixture("no-mistakes-evidence-clean-success.json") as {
      pullRequest: { headSha: string };
    };
    evidence.pullRequest.headSha = "2222222222222222222222222222222222222222";

    const { pullRequest: _pullRequest, ...expectedWithoutPullRequest } = EXPECTED;
    const out = classifyNoMistakesDeterministicEvidence(
      evidence,
      expectedWithoutPullRequest
    );

    expect(out).toMatchObject({
      ok: false,
      reason: "pull_request_mismatch"
    });
  });

  it("refuses malformed or unknown-version evidence", () => {
    const out = classifyNoMistakesDeterministicEvidence(
      fixture("no-mistakes-evidence-unknown-schema.json"),
      EXPECTED
    );

    expect(out).toMatchObject({ ok: false, reason: "unknown_schema" });
  });
});

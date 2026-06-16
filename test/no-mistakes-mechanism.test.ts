import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decideNoMistakesMirror } from "../src/adapters/no-mistakes-executor.js";
import type { NoMistakesExternalState } from "../src/adapters/no-mistakes-executor.js";
import {
  MAX_NO_MISTAKES_EXTERNAL_STATE_BYTES,
  parseNoMistakesExternalState,
  readNoMistakesExternalState
} from "../src/core/executors/no-mistakes-mechanism.js";

// Proves the no-mistakes executor *mechanism* — the external-state reader — turns
// the untrusted raw external no-mistakes state store into the typed
// {@link NoMistakesExternalState} snapshot the pure brain classifies, without
// re-running no-mistakes. The defining seam (NGX-351 "Treat external no-mistakes
// state as evidence to classify, not blindly trusted authority"): the mechanism
// owns *JSON-type* validation (is this even the right shape?), while the pure
// brain (`decideNoMistakesMirror`) owns *semantic* validation (enum membership,
// SHA format, dangling refs). A well-typed-but-semantically-bad snapshot parses
// here and is rejected there.

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix = "momentum-no-mistakes-mechanism-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return fs.realpathSync(dir);
}

function writeStateFile(content: string): string {
  const dir = makeTempDir();
  const statePath = path.join(dir, "no-mistakes-state.json");
  fs.writeFileSync(statePath, content, "utf-8");
  return statePath;
}

function writeStateFileBytes(content: Buffer): string {
  const dir = makeTempDir();
  const statePath = path.join(dir, "no-mistakes-state.json");
  fs.writeFileSync(statePath, content);
  return statePath;
}

function sha256Digest(content: string | Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

const VALID_HEAD_SHA = "a".repeat(40);

function fullSnapshotObject(): Record<string, unknown> {
  return {
    externalRunId: "nm-run-1",
    branch: "feat/ngx-351",
    headSha: VALID_HEAD_SHA,
    activeStep: "review",
    stepStatus: "running",
    findings: [
      {
        externalId: "F-1",
        title: "unhandled null",
        severity: "high",
        detail: "line 42"
      },
      { externalId: "F-2", title: "missing test" }
    ],
    selectedFindingIds: ["F-1"],
    decisions: [
      {
        externalId: "D-1",
        summary: "merge strategy",
        allowedActions: ["squash", "rebase"],
        recommendedAction: "squash",
        chosenAction: "squash",
        resolution: "delegated-policy: squash"
      }
    ],
    prUrl: "https://github.com/x/y/pull/1",
    ciState: "passed"
  };
}

describe("parseNoMistakesExternalState", () => {
  it("parses a well-formed full snapshot into the typed mirror state", () => {
    const raw = JSON.stringify(fullSnapshotObject());

    const read = parseNoMistakesExternalState(raw);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const expected: NoMistakesExternalState = {
      externalRunId: "nm-run-1",
      branch: "feat/ngx-351",
      headSha: VALID_HEAD_SHA,
      activeStep: "review",
      stepStatus: "running",
      findings: [
        {
          externalId: "F-1",
          title: "unhandled null",
          severity: "high",
          detail: "line 42"
        },
        { externalId: "F-2", title: "missing test", severity: null, detail: null }
      ],
      selectedFindingIds: ["F-1"],
      decisions: [
        {
          externalId: "D-1",
          summary: "merge strategy",
          allowedActions: ["squash", "rebase"],
          recommendedAction: "squash",
          chosenAction: "squash",
          resolution: "delegated-policy: squash"
        }
      ],
      prUrl: "https://github.com/x/y/pull/1",
      ciState: "passed"
    };
    expect(read.value).toEqual(expected);
  });

  it("fingerprints the parsed snapshot with a sha256 digest of the raw bytes", () => {
    const raw = JSON.stringify(fullSnapshotObject());

    const read = parseNoMistakesExternalState(raw);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.digest).toBe(sha256Digest(raw));
  });

  it("feeds a parsed running snapshot straight into the brain as a continue", () => {
    const raw = JSON.stringify(fullSnapshotObject());

    const read = parseNoMistakesExternalState(raw);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const decision = decideNoMistakesMirror(read.value);
    expect(decision.classification).toBe("continue");
    expect(decision.roundState).toBe("mirroring_external_state");
  });

  it("accepts null activeStep / prUrl and empty finding / decision arrays", () => {
    const raw = JSON.stringify({
      ...fullSnapshotObject(),
      activeStep: null,
      prUrl: null,
      findings: [],
      selectedFindingIds: [],
      decisions: []
    });

    const read = parseNoMistakesExternalState(raw);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.activeStep).toBeNull();
    expect(read.value.prUrl).toBeNull();
    expect(read.value.findings).toEqual([]);
    expect(read.value.decisions).toEqual([]);
  });

  it("normalizes absent optional finding / decision fields to null", () => {
    const raw = JSON.stringify({
      ...fullSnapshotObject(),
      findings: [{ externalId: "F-9", title: "bare finding" }],
      selectedFindingIds: [],
      decisions: [
        { externalId: "D-9", summary: "bare decision", allowedActions: ["ok"] }
      ]
    });

    const read = parseNoMistakesExternalState(raw);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.findings[0]).toEqual({
      externalId: "F-9",
      title: "bare finding",
      severity: null,
      detail: null
    });
    expect(read.value.decisions[0]).toEqual({
      externalId: "D-9",
      summary: "bare decision",
      allowedActions: ["ok"],
      recommendedAction: null,
      chosenAction: null,
      resolution: null
    });
  });

  it("rejects raw bytes that are not valid JSON", () => {
    const read = parseNoMistakesExternalState("{ not json");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/not valid JSON/i);
  });

  it("rejects a non-object JSON root (array)", () => {
    const read = parseNoMistakesExternalState(JSON.stringify([1, 2, 3]));

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/object/i);
  });

  it("rejects a non-string externalRunId", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({ ...fullSnapshotObject(), externalRunId: 7 })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/externalRunId/i);
  });

  it("rejects a non-string headSha", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({ ...fullSnapshotObject(), headSha: 12345 })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/headSha/i);
  });

  it("rejects an activeStep that is neither string nor null", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({ ...fullSnapshotObject(), activeStep: 3 })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/activeStep/i);
  });

  it("rejects a non-string stepStatus", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({ ...fullSnapshotObject(), stepStatus: 1 })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/stepStatus/i);
  });

  it("rejects a non-string ciState", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({ ...fullSnapshotObject(), ciState: false })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/ciState/i);
  });

  it("rejects findings that are not an array", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({ ...fullSnapshotObject(), findings: "nope" })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/findings/i);
  });

  it("rejects a finding element that is not an object", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({
        ...fullSnapshotObject(),
        findings: ["F-1"],
        selectedFindingIds: []
      })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/finding/i);
  });

  it("rejects a finding with a non-string externalId", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({
        ...fullSnapshotObject(),
        findings: [{ externalId: 1, title: "t" }],
        selectedFindingIds: []
      })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/finding/i);
  });

  it("rejects a finding with a non-string title", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({
        ...fullSnapshotObject(),
        findings: [{ externalId: "F-1", title: 9 }],
        selectedFindingIds: []
      })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/finding/i);
  });

  it("rejects a finding with a wrong-typed optional field", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({
        ...fullSnapshotObject(),
        findings: [{ externalId: "F-1", title: "t", severity: 5 }],
        selectedFindingIds: []
      })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/severity/i);
  });

  it("rejects selectedFindingIds that contain a non-string", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({ ...fullSnapshotObject(), selectedFindingIds: [1] })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/selectedFindingIds/i);
  });

  it("rejects a decision with non-array allowedActions", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({
        ...fullSnapshotObject(),
        decisions: [
          { externalId: "D-1", summary: "s", allowedActions: "squash" }
        ]
      })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/allowedActions/i);
  });

  it("rejects a decision whose allowedActions contain a non-string", () => {
    const read = parseNoMistakesExternalState(
      JSON.stringify({
        ...fullSnapshotObject(),
        decisions: [{ externalId: "D-1", summary: "s", allowedActions: [1] }]
      })
    );

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/allowedActions/i);
  });

  it("parses a well-typed but semantically bad snapshot for the brain to reject (unknown stepStatus)", () => {
    const raw = JSON.stringify({
      ...fullSnapshotObject(),
      stepStatus: "exploding"
    });

    const read = parseNoMistakesExternalState(raw);

    // The mechanism owns types, not semantics: a string stepStatus parses here.
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The brain owns semantics: an unknown enum value routes to manual recovery.
    const decision = decideNoMistakesMirror(read.value);
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.recoveryCode).toBe("external_state_unreadable");
  });

  it("parses a dangling selected finding id for the brain to reject", () => {
    const raw = JSON.stringify({
      ...fullSnapshotObject(),
      findings: [{ externalId: "F-1", title: "t" }],
      selectedFindingIds: ["F-404"]
    });

    const read = parseNoMistakesExternalState(raw);

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const decision = decideNoMistakesMirror(read.value);
    expect(decision.classification).toBe("manual_recovery_required");
    expect(decision.recoveryCode).toBe("external_state_unreadable");
  });
});

describe("readNoMistakesExternalState", () => {
  it("reads a well-formed state file into the typed mirror state + digest", () => {
    const raw = JSON.stringify(fullSnapshotObject());
    const statePath = writeStateFile(raw);

    const read = readNoMistakesExternalState({ statePath });

    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.externalRunId).toBe("nm-run-1");
    expect(read.digest).toBe(sha256Digest(raw));
  });

  it("rejects malformed UTF-8 bytes before JSON parsing", () => {
    const raw = Buffer.from(
      JSON.stringify({
        ...fullSnapshotObject(),
        externalRunId: "nm-run-\ufffd("
      }).replace("\ufffd", "\xc3"),
      "latin1"
    );
    const statePath = writeStateFileBytes(raw);

    const read = readNoMistakesExternalState({ statePath });

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/utf-?8|decode/i);
  });

  it("returns an unreadable error when the state file does not exist", () => {
    const statePath = path.join(makeTempDir(), "absent-state.json");

    const read = readNoMistakesExternalState({ statePath });

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/unreadable|read/i);
  });

  it("returns an unreadable error when the state file is not valid JSON", () => {
    const statePath = writeStateFile("{ broken json");

    const read = readNoMistakesExternalState({ statePath });

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/not valid JSON/i);
  });

  it("returns an unreadable error when the state file exceeds the read cap", () => {
    const statePath = writeStateFile("x".repeat(1024 * 1024 + 1));

    const read = readNoMistakesExternalState({ statePath });

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/too large/i);
  });

  it("returns an unreadable error when the state file grows after the path stat", () => {
    const statePath = writeStateFile(JSON.stringify(fullSnapshotObject()));
    const statSync = fs.statSync.bind(fs);
    vi.spyOn(fs, "statSync").mockImplementation((pathLike, options) => {
      const stat = statSync(pathLike, options as fs.StatSyncOptions);
      fs.writeFileSync(
        statePath,
        "x".repeat(MAX_NO_MISTAKES_EXTERNAL_STATE_BYTES + 1)
      );
      return stat;
    });

    const read = readNoMistakesExternalState({ statePath });

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/too large/i);
  });

  it("returns an unreadable error when the state path is not a regular file", () => {
    const statePath = makeTempDir();

    const read = readNoMistakesExternalState({ statePath });

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error).toMatch(/regular file/i);
  });
});

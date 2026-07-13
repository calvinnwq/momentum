import crypto from "node:crypto";

import {
  readNoMistakesExternalState,
  type NoMistakesExternalStateRead,
} from "../core/executors/no-mistakes/mechanism.js";
import type {
  DelegateSupervisorExternalIdentity,
  DelegateSupervisorExternalState,
  DelegateSupervisorExternalStateRead,
  DelegateSupervisorHandoff,
  DelegateSupervisorToolAdapter,
  DelegateSupervisorToolContext,
} from "../core/executors/delegate-supervisor/types.js";

export type NoMistakesToolAdapterOptions = {
  /** Spawn or attach to no-mistakes and return its pinned external identity. */
  handoff: (
    context: DelegateSupervisorToolContext,
  ) => DelegateSupervisorHandoff | Promise<DelegateSupervisorHandoff>;
  recoverHandoff?: (
    context: DelegateSupervisorToolContext,
  ) => DelegateSupervisorHandoff | Promise<DelegateSupervisorHandoff>;
  /** Resolve the no-mistakes state artifact for each bounded supervisor poll. */
  statePath: (
    context: DelegateSupervisorToolContext & {
      handoff: Readonly<DelegateSupervisorHandoff>;
    },
  ) => string;
  /** Refresh the state artifact before each bounded supervisor read. */
  refreshState?: (
    context: DelegateSupervisorToolContext & {
      handoff: Readonly<DelegateSupervisorHandoff>;
    },
  ) =>
    | NoMistakesExternalStateRead
    | void
    | Promise<NoMistakesExternalStateRead | void>;
  read?: (statePath: string) => NoMistakesExternalStateRead;
};

/**
 * Concrete no-mistakes tool edge. It contains no durable lifecycle or terminal
 * classification logic; those belong to the delegate-supervisor executor.
 */
export function createNoMistakesToolAdapter(
  options: NoMistakesToolAdapterOptions,
): DelegateSupervisorToolAdapter {
  return {
    name: "no-mistakes",
    handoff: options.handoff,
    ...(options.recoverHandoff !== undefined
      ? { recoverHandoff: options.recoverHandoff }
      : {}),
    readExternalState: async (context) => {
      const refreshed = await options.refreshState?.(context);
      if (refreshed !== undefined) return refreshed;
      return (
        options.read ??
        ((statePath) => readNoMistakesExternalState({ statePath }))
      )(options.statePath(context));
    },
  };
}

export type NoMistakesLaunchIdentityRead =
  | { ok: true; value: DelegateSupervisorExternalIdentity }
  | { ok: false; error: string };

export type ParseNoMistakesAxiStatusOptions = {
  resolveHeadSha?: (abbreviatedHead: string) => string | null;
  isHeadDescendant?: (launchHead: string, observedHead: string) => boolean;
  previousState?: DelegateSupervisorExternalState;
};

type SuccessfulNoMistakesExternalStateRead = Extract<
  DelegateSupervisorExternalStateRead,
  { ok: true }
>;

const CLEARED_CURRENT_STEP_FINDINGS_DETAIL =
  "aggregate run findings remain, but every current step row reports zero findings";

/** Preserve terminal evidence returned by `axi run` even when `axi status` lags. */
export function settleNoMistakesHandoffState(
  read: SuccessfulNoMistakesExternalStateRead,
  terminalProofHeadSha: string | null,
): SuccessfulNoMistakesExternalStateRead {
  if (
    terminalProofHeadSha === null ||
    !commitIdentitiesMatch(terminalProofHeadSha, read.value.headSha)
  ) {
    return read;
  }
  const laggingMonitoringState =
    read.value.stepStatus === "running" &&
    (read.value.ciState === "passed" || read.value.ciState === "none") &&
    (read.value.findings.length === 0 ||
      (read.value.findings.length === 1 &&
        read.value.findings[0]?.externalId === "active-findings" &&
        read.value.findings[0].detail ===
          CLEARED_CURRENT_STEP_FINDINGS_DETAIL)) &&
    read.value.selectedFindingIds.length === 0 &&
    read.value.decisions.length === 0;
  if (!laggingMonitoringState) return read;
  const value: DelegateSupervisorExternalState = {
    ...read.value,
    activeStep: null,
    stepStatus: "completed",
    findings: [],
    selectedFindingIds: [],
    decisions: [],
    ciState: read.value.ciState,
  };
  return {
    ok: true,
    value,
    digest: `sha256:${crypto
      .createHash("sha256")
      .update(JSON.stringify({ handoffDigest: read.digest, value }))
      .digest("hex")}`,
    ...(read.headRelation !== undefined
      ? { headRelation: read.headRelation }
      : {}),
  };
}

export function commitIdentitiesMatch(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (
    !/^[0-9a-f]{7,40}$/.test(normalizedLeft) ||
    !/^[0-9a-f]{7,40}$/.test(normalizedRight)
  ) {
    return false;
  }
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.length === 40) {
    return normalizedLeft.startsWith(normalizedRight);
  }
  if (normalizedRight.length === 40) {
    return normalizedRight.startsWith(normalizedLeft);
  }
  return false;
}

/**
 * Read only the durable identity from `axi run` output. The launch envelope
 * reports a gate or outcome, not the richer shape returned by `axi status`.
 */
export function parseNoMistakesLaunchIdentity(
  raw: string,
  expected: Pick<DelegateSupervisorExternalIdentity, "branch" | "headSha">,
): NoMistakesLaunchIdentityRead {
  const externalRunId =
    toonSectionScalar(raw, "run", "id") ??
    topLevelToonScalar(raw, "id") ??
    /^\s*id:\s*"?([^"\s]+)"?\s*$/m.exec(raw)?.[1] ??
    null;
  if (externalRunId === null || externalRunId.trim().length === 0) {
    return {
      ok: false,
      error: "no-mistakes launch output did not report the delegated run id",
    };
  }
  return {
    ok: true,
    value: {
      externalRunId,
      branch: expected.branch,
      headSha: expected.headSha,
    },
  };
}

/** Normalize token-efficient `no-mistakes axi status` output at the adapter edge. */
export function parseNoMistakesAxiStatus(
  raw: string,
  expected: DelegateSupervisorExternalIdentity,
  options: ParseNoMistakesAxiStatusOptions = {},
): DelegateSupervisorExternalStateRead {
  const currentRaw = stripHistoricalToonSections(raw);
  const runId = toonSectionScalar(currentRaw, "run", "id");
  const branch = toonSectionScalar(currentRaw, "run", "branch");
  const runStatus = toonSectionScalar(currentRaw, "run", "status");
  const reportedHead = toonSectionScalar(currentRaw, "run", "head");
  if (
    runId === null ||
    branch === null ||
    runStatus === null ||
    reportedHead === null
  ) {
    return {
      ok: false,
      error:
        "no-mistakes axi status did not report run id, branch, status, and head",
    };
  }
  if (runId !== expected.externalRunId || branch !== expected.branch) {
    return {
      ok: false,
      error: `no-mistakes axi status identity mismatch: expected ${expected.externalRunId}/${expected.branch}, observed ${runId}/${branch}`,
    };
  }
  const normalizedReportedHead = reportedHead.toLowerCase();
  const resolvedReportedHead = /^[0-9a-f]{40}$/i.test(reportedHead)
    ? normalizedReportedHead
    : /^[0-9a-f]{7,39}$/i.test(reportedHead)
      ? (options.resolveHeadSha?.(normalizedReportedHead) ??
        normalizedReportedHead)
      : null;
  if (resolvedReportedHead === null) {
    return {
      ok: false,
      error: `no-mistakes axi status reported invalid head ${reportedHead}`,
    };
  }
  if (
    resolvedReportedHead !== expected.headSha.toLowerCase() &&
    options.isHeadDescendant?.(
      expected.headSha.toLowerCase(),
      resolvedReportedHead,
    ) !== true
  ) {
    return {
      ok: false,
      error: `no-mistakes axi status head ${reportedHead} is not a verified descendant of launch head ${expected.headSha}`,
    };
  }

  const gateStatus = toonSectionScalar(currentRaw, "gate", "status");
  const gateStep = toonSectionScalar(currentRaw, "gate", "step");
  const gateSummary = toonSectionScalar(currentRaw, "gate", "summary");
  const outcome = topLevelToonScalar(currentRaw, "outcome");
  const allowedRunStatuses = new Set([
    "running",
    "completed",
    "failed",
    "cancelled",
    "blocked",
  ]);
  if (!allowedRunStatuses.has(runStatus)) {
    return {
      ok: false,
      error: `no-mistakes axi status reported unknown run status ${runStatus}`,
    };
  }
  if (
    outcome !== null &&
    !["checks-passed", "passed", "failed", "cancelled", "aborted"].includes(
      outcome,
    )
  ) {
    return {
      ok: false,
      error: `no-mistakes axi status reported unknown outcome ${outcome}`,
    };
  }
  if (
    gateStatus !== null &&
    !["awaiting_approval", "awaiting_decision"].includes(gateStatus)
  ) {
    return {
      ok: false,
      error: `no-mistakes axi status reported unknown gate status ${gateStatus}`,
    };
  }
  const stepRows = parseNoMistakesStepRows(currentRaw);
  const activeStep =
    gateStep ??
    stepRows.find(
      (row) => !["completed", "skipped", "pending"].includes(row.status),
    )?.step ??
    null;
  const runFindings = toonSectionScalar(currentRaw, "run", "findings");
  const hasStepFindings = stepRows.some((row) => row.findings > 0);
  const hasRunFindings =
    runFindings !== null && !/^0(?:\s|$)/.test(runFindings);
  const hasActiveFindings = hasStepFindings || hasRunFindings;
  const allowedActions = [
    ...currentRaw.matchAll(/--action\s+([a-z0-9_-]+)/gi),
  ].map((match) => match[1]!.toLowerCase());
  const uniqueActions = [...new Set(allowedActions)];
  const hasBlockingGate = gateStatus !== null;
  const hasContradictoryPullRequest =
    hasContradictoryPullRequestEvidence(currentRaw);
  const hasCleanPullRequest = hasCleanPullRequestEvidence(currentRaw);
  const prUrl = toonSectionScalar(currentRaw, "run", "pr");
  const ciStatus = /^\s*ci,(?<status>[^,\s]+)/m.exec(currentRaw)?.groups
    ?.status;
  const blockingOutcome =
    outcome === "failed" || outcome === "cancelled" || outcome === "aborted";
  const terminalOutcomeClaim =
    outcome === "checks-passed" ||
    outcome === "passed" ||
    runStatus === "completed";
  const monitoringSuccessClaim =
    runStatus === "running" &&
    hasCleanPullRequest &&
    (ciStatus === "completed" || ciStatus === "skipped");
  const hasPendingCi = ciStatus === "pending" || ciStatus === "running";
  const currentTerminalClaim =
    (terminalOutcomeClaim || monitoringSuccessClaim) &&
    !blockingOutcome &&
    !hasPendingCi &&
    !hasBlockingGate &&
    !hasActiveFindings &&
    !hasContradictoryPullRequest;
  const stepStatus =
    outcome === "cancelled" ||
    outcome === "aborted" ||
    runStatus === "cancelled"
      ? "cancelled"
      : outcome === "failed" || runStatus === "failed"
        ? "failed"
        : gateStatus === "awaiting_approval"
          ? "awaiting_approval"
          : gateStatus === "awaiting_decision"
            ? "awaiting_decision"
            : runStatus === "completed" && hasActiveFindings
              ? "completed"
              : runStatus === "blocked" ||
                  hasBlockingGate ||
                  hasContradictoryPullRequest
                ? "blocked"
                : currentTerminalClaim
                  ? "completed"
                  : "running";
  if (
    ciStatus !== undefined &&
    ![
      "completed",
      "failed",
      "pending",
      "running",
      "skipped",
      "blocked",
      "awaiting_approval",
      "awaiting_decision",
    ].includes(ciStatus)
  ) {
    return {
      ok: false,
      error: `no-mistakes axi status reported unknown CI status ${ciStatus}`,
    };
  }
  const ciState =
    ciStatus === "failed"
      ? "failed"
      : ciStatus === "completed"
        ? "passed"
        : ciStatus === "skipped"
          ? "none"
          : ciStatus !== undefined
            ? "pending"
            : (outcome === "checks-passed" || outcome === "passed") &&
                currentTerminalClaim
              ? "passed"
              : "pending";
  const findings = hasActiveFindings
    ? [
        {
          externalId: "active-findings",
          title:
            runFindings ?? "no-mistakes step table reports active findings",
          severity: null,
          detail:
            hasRunFindings && stepRows.length > 0 && !hasStepFindings
              ? CLEARED_CURRENT_STEP_FINDINGS_DETAIL
              : gateSummary,
        },
      ]
    : [];
  const completedSteps = new Set(
    [...currentRaw.matchAll(/^\s+([^,\s]+),completed(?:,|$)/gm)].map(
      (match) => match[1]!,
    ),
  );
  const previousState = options.previousState;
  const previousDecisions =
    previousState !== undefined &&
    previousState.externalRunId === expected.externalRunId &&
    previousState.branch === expected.branch
      ? previousState.decisions
      : [];
  const carriedDecisions = previousDecisions.map((decision) => {
    if (
      (decision.resolution !== null && decision.resolution !== undefined) ||
      !completedSteps.has(decision.externalId)
    ) {
      return decision;
    }
    const resolutionAction = "external_resolution";
    return {
      ...decision,
      allowedActions: decision.allowedActions.includes(resolutionAction)
        ? decision.allowedActions
        : [...decision.allowedActions, resolutionAction],
      chosenAction: resolutionAction,
      resolution: `no-mistakes step ${decision.externalId} completed after its decision gate`,
    };
  });
  const currentDecision =
    stepStatus === "awaiting_decision"
      ? {
          externalId: activeStep ?? "external-decision",
          summary: gateSummary ?? "no-mistakes requires an operator decision",
          allowedActions:
            uniqueActions.length > 0
              ? uniqueActions
              : ["inspect_external_decision"],
          recommendedAction: uniqueActions[0] ?? "inspect_external_decision",
          chosenAction: null,
          resolution: null,
        }
      : null;
  const decisions =
    currentDecision === null
      ? carriedDecisions
      : [
          ...carriedDecisions.filter(
            (decision) => decision.externalId !== currentDecision.externalId,
          ),
          currentDecision,
        ];
  return {
    ok: true,
    value: {
      externalRunId: runId,
      branch,
      headSha: resolvedReportedHead,
      activeStep,
      stepStatus,
      findings,
      selectedFindingIds: [],
      decisions,
      prUrl,
      ciState,
    },
    digest: `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`,
    ...(resolvedReportedHead !== expected.headSha.toLowerCase()
      ? { headRelation: "verified_descendant" as const }
      : {}),
  };
}

function hasContradictoryPullRequestEvidence(raw: string): boolean {
  return (
    /^\s*(?:is[_ -]?draft|draft):\s*(?:true|yes|1|draft)\s*$/im.test(raw) ||
    /^\s*(?:pr[_ -]?clean|clean):\s*(?:false|no|0|dirty|unknown)\s*$/im.test(
      raw,
    ) ||
    /^\s*(?:merge[_ -]?state|mergeable[_ -]?state):\s*(?:behind|blocked|dirty|draft|has[_ -]?hooks|unknown|unstable)\s*$/im.test(
      raw,
    )
  );
}

function hasCleanPullRequestEvidence(raw: string): boolean {
  return (
    /^\s*(?:pr[_ -]?clean|clean):\s*(?:true|yes|1|clean)\s*$/im.test(raw) ||
    /^\s*(?:merge[_ -]?state|mergeable[_ -]?state):\s*(?:clean|mergeable|ready)\s*$/im.test(
      raw,
    )
  );
}

function parseNoMistakesStepRows(raw: string): Array<{
  step: string;
  status: string;
  findings: number;
}> {
  return [
    ...raw.matchAll(
      /^\s+(?<step>[a-z0-9_-]+),(?<status>[a-z0-9_-]+),(?<findings>\d+),[^,\s]+\s*$/gim,
    ),
  ].map((match) => ({
    step: match.groups!.step!,
    status: match.groups!.status!.toLowerCase(),
    findings: Number(match.groups!.findings),
  }));
}

function stripHistoricalToonSections(raw: string): string {
  const kept: string[] = [];
  let historicalIndent: number | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const indent = line.length - line.trimStart().length;
    if (historicalIndent !== null) {
      if (line.trim().length === 0 || indent > historicalIndent) continue;
      historicalIndent = null;
    }
    if (/^(?:previous|historical|history):\s*$/i.test(line.trim())) {
      historicalIndent = indent;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function topLevelToonScalar(raw: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m").exec(raw);
  return match?.[1] === undefined ? null : unquote(match[1]);
}

function toonSectionScalar(
  raw: string,
  section: string,
  key: string,
): string | null {
  const lines = raw.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => line.trim() === `${section}:`);
  if (sectionIndex < 0) return null;
  for (const line of lines.slice(sectionIndex + 1)) {
    if (line.length > 0 && !/^\s/.test(line)) break;
    const match = new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`).exec(line);
    if (match?.[1] !== undefined) return unquote(match[1]);
  }
  return null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

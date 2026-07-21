import type {
  ExecutorCompletionClassification,
  ExecutorHumanGateType,
  ExecutorAttemptRecord,
  ExecutorAttemptState,
  ExecutorRoundState,
} from "../loop/reducer.js";

export const DELEGATE_SUPERVISOR_EXTERNAL_STATUSES = [
  "running",
  "awaiting_decision",
  "awaiting_approval",
  "blocked",
  "failed",
  "cancelled",
  "completed",
] as const;

export type DelegateSupervisorExternalStatus =
  (typeof DELEGATE_SUPERVISOR_EXTERNAL_STATUSES)[number];

export const DELEGATE_SUPERVISOR_CI_STATES = [
  "passed",
  "failed",
  "pending",
  "none",
] as const;

export type DelegateSupervisorCiState =
  (typeof DELEGATE_SUPERVISOR_CI_STATES)[number];

export type DelegateSupervisorExternalFinding = {
  externalId: string;
  title: string;
  severity?: string | null;
  detail?: string | null;
};

export type DelegateSupervisorExternalDecision = {
  externalId: string;
  summary: string;
  allowedActions: readonly string[];
  recommendedAction?: string | null;
  chosenAction?: string | null;
  resolution?: string | null;
};

/** Reserved for the supervisor-owned approval gate; adapters must not emit it. */
export const DELEGATE_SUPERVISOR_SYNTHETIC_APPROVAL_EXTERNAL_ID =
  "delegate-supervisor:synthetic-approval-gate";

/** Canonical state every delegated-tool adapter normalizes into. */
export type DelegateSupervisorExternalState = {
  externalRunId: string;
  branch: string;
  headSha: string;
  activeStep: string | null;
  stepStatus: DelegateSupervisorExternalStatus;
  findings: readonly DelegateSupervisorExternalFinding[];
  selectedFindingIds: readonly string[];
  decisions: readonly DelegateSupervisorExternalDecision[];
  prUrl: string | null;
  ciState: DelegateSupervisorCiState;
};

export type DelegateSupervisorExternalIdentity = Pick<
  DelegateSupervisorExternalState,
  "externalRunId" | "branch" | "headSha"
>;

export type DelegateSupervisorHeadRelation = "verified_descendant";

export type DelegateSupervisorExternalStateRead =
  | {
      ok: true;
      value: DelegateSupervisorExternalState;
      /** Digest of the exact external bytes or response that produced value. */
      digest: string;
      /** Required when value.headSha differs from the handoff launch head. */
      headRelation?: DelegateSupervisorHeadRelation;
    }
  | { ok: false; error: string };

export type DelegateSupervisorDecision = {
  classification: ExecutorCompletionClassification;
  roundState: ExecutorRoundState;
  attemptState: ExecutorAttemptState;
  humanGate: ExecutorHumanGateType | null;
  recoveryCode: string | null;
  reason: string;
};

export type DelegateSupervisorHandoff = {
  /** `headSha` must be a canonical lowercase full 40-character commit SHA. */
  externalIdentity: DelegateSupervisorExternalIdentity;
  summary: string;
  artifactPaths?: readonly string[];
  /** Cached candidate; a fresh read must corroborate run, branch, and full head SHA. */
  terminalState?: {
    value: DelegateSupervisorExternalState;
    digest: string;
    headRelation?: DelegateSupervisorHeadRelation;
  };
};

export type DelegateSupervisorToolContext = {
  attempt: Readonly<ExecutorAttemptRecord>;
  config: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
};

/**
 * Infrastructure boundary for one autonomous delegated tool.
 *
 * Adapters own only the tool-specific handoff and read/normalization work.
 * The delegate-supervisor executor owns durable rounds, evidence projection,
 * liveness, stalls, gates, and terminal classification.
 */
export interface DelegateSupervisorToolAdapter {
  /** Must exactly match the portable `tool` value that selects this adapter. */
  readonly name: string;
  handoff(
    context: DelegateSupervisorToolContext,
  ): DelegateSupervisorHandoff | Promise<DelegateSupervisorHandoff>;
  /**
   * Reconcile an interrupted intent without duplicating an unresolved launch.
   * Retry attempts also call this before reusing a prior valid handoff so the
   * adapter can reconcile host-local receipts and finalization evidence.
   * A newer attempt may launch once after prior evidence is conclusively failed
   * or cancelled.
   */
  recoverHandoff?(
    context: DelegateSupervisorToolContext,
  ): DelegateSupervisorHandoff | Promise<DelegateSupervisorHandoff>;
  readExternalState(
    context: DelegateSupervisorToolContext & {
      handoff: Readonly<DelegateSupervisorHandoff>;
    },
  ):
    | DelegateSupervisorExternalStateRead
    | Promise<DelegateSupervisorExternalStateRead>;
}

export type DelegateSupervisorHostBindings = {
  tools:
    | ReadonlyMap<string, DelegateSupervisorToolAdapter>
    | Readonly<Record<string, DelegateSupervisorToolAdapter>>;
  now?: () => number;
  /** Host repository ownership is released only after handoff evidence is durable. */
  settleHandoff?: (durable: boolean) => void;
};

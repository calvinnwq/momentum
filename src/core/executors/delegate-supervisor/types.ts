import type {
  ExecutorCompletionClassification,
  ExecutorHumanGateType,
  ExecutorInvocationRecord,
  ExecutorInvocationState,
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

export type DelegateSupervisorExternalStateRead =
  | {
      ok: true;
      value: DelegateSupervisorExternalState;
      /** Digest of the exact external bytes or response that produced value. */
      digest: string;
    }
  | { ok: false; error: string };

export type DelegateSupervisorDecision = {
  classification: ExecutorCompletionClassification;
  roundState: ExecutorRoundState;
  invocationState: ExecutorInvocationState;
  humanGate: ExecutorHumanGateType | null;
  recoveryCode: string | null;
  reason: string;
};

export type DelegateSupervisorHandoff = {
  externalIdentity: DelegateSupervisorExternalIdentity;
  summary: string;
  artifactPaths?: readonly string[];
};

export type DelegateSupervisorToolContext = {
  invocation: Readonly<ExecutorInvocationRecord>;
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
  readonly name: string;
  handoff(
    context: DelegateSupervisorToolContext,
  ): DelegateSupervisorHandoff | Promise<DelegateSupervisorHandoff>;
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

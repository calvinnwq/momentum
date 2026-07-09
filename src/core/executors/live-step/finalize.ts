/**
 * M9 live-step finalization back-compat surface.
 *
 * The shared verify -> commit / reset finalization transaction this module used
 * to own moved to the neutrally-owned
 * {@link ../shared/step-finalize.ts} seam, so the goal-loop
 * executor-loop family no longer reaches into an M9-named module for it. This
 * module re-exports that seam under the live-step lane's original
 * `*LiveWorkflowStep*` / `LiveWorkflowFinalize*` names so the consumers that
 * still rely on that surface keep it with no behavior change: the M9 live
 * wrappers (`live-step/advance.ts`, `live-step/run-recovery.ts`), the M10
 * single-shot executor family (`single-shot/mechanism.ts`), and the M9 finalize
 * tests.
 *
 * New shared callers should import the neutral names directly from
 * `shared/step-finalize.ts`; the goal-loop family already imports them
 * directly. This alias surface stays as a compatibility seam until the
 * remaining consumers are themselves migrated or retired.
 */

export {
  finalizeWorkflowStep as finalizeLiveWorkflowStep,
  finalizeWorkflowStepFromResultFile as finalizeLiveWorkflowStepFromResultFile
} from "../shared/step-finalize.js";

export type {
  FinalizeWorkflowStepInput as FinalizeLiveWorkflowStepInput,
  FinalizeWorkflowStepResult as FinalizeLiveWorkflowStepResult,
  FinalizeWorkflowStepFromResultFileInput as FinalizeLiveWorkflowStepFromResultFileInput,
  FinalizeWorkflowStepFromResultFileResult as FinalizeLiveWorkflowStepFromResultFileResult,
  WorkflowStepFinalizeRecoveryCode as LiveWorkflowFinalizeRecoveryCode,
  WorkflowStepFinalizeRecoveryTrigger as LiveWorkflowFinalizeRecoveryTrigger
} from "../shared/step-finalize.js";

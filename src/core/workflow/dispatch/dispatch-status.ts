import { WORKFLOW_DISPATCH_RESULT_STATUS } from "./execute.js";

export function shouldDriveDispatchedExecutor(status: string): boolean {
  return (
    status === WORKFLOW_DISPATCH_RESULT_STATUS.dispatched ||
    status === WORKFLOW_DISPATCH_RESULT_STATUS.alreadyDispatched
  );
}

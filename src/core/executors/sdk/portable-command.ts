/** Portable script capability identity shared by SDK config and host profiles. */

export const SCRIPT_COMMAND_IDENTITY_PATTERN =
  "^(?!\\.{1,2}$)(?![A-Za-z]:)[A-Za-z0-9@][A-Za-z0-9._:@+-]*$";

export function isPortableScriptCommandIdentity(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    new RegExp(SCRIPT_COMMAND_IDENTITY_PATTERN).test(value)
  );
}

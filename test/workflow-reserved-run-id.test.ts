import { describe, expect, it } from "vitest";

import {
  COMPATIBILITY_RUN_ID_PREFIXES,
  isReservedCompatibilityRunId
} from "../src/core/workflow/run/import.js";

describe("isReservedCompatibilityRunId (NGX-508)", () => {
  it("recognizes the cwfp/cwfb/overnight compatibility prefixes", () => {
    expect(COMPATIBILITY_RUN_ID_PREFIXES).toEqual(["cwfp", "cwfb", "overnight"]);
  });

  it("flags ids that begin with a reserved compatibility prefix", () => {
    expect(isReservedCompatibilityRunId("cwfp-abc123")).toBe(true);
    expect(isReservedCompatibilityRunId("cwfb-xyz")).toBe(true);
    expect(isReservedCompatibilityRunId("overnight-safe-99")).toBe(true);
  });

  it("flags reserved-looking ids even when the suffix would not pass strict import parsing", () => {
    // The import basename pattern requires a single trailing alphanumeric run,
    // but the native-door guard is intentionally stricter: anything that starts
    // with a reserved prefix is treated as compatibility-reserved.
    expect(isReservedCompatibilityRunId("cwfp-multi-segment-id")).toBe(true);
  });

  it("does not flag native Momentum run ids", () => {
    expect(isReservedCompatibilityRunId("ngx-508-native-1")).toBe(false);
    expect(isReservedCompatibilityRunId("run-1")).toBe(false);
    // A bare prefix without the hyphen separator is not reserved.
    expect(isReservedCompatibilityRunId("cwfp")).toBe(false);
    expect(isReservedCompatibilityRunId("overnightly")).toBe(false);
  });
});

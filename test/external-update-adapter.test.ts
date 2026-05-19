import { describe, expect, it } from "vitest";

import {
  BUILTIN_EXTERNAL_UPDATE_ADAPTER_KINDS,
  EXTERNAL_UPDATE_ADAPTER_ERROR_CODES,
  EXTERNAL_UPDATE_MUTATION_KINDS,
  buildIdempotencyMarker,
  getExternalUpdateAdapter,
  listExternalUpdateAdapterKinds,
  listExternalUpdateAdapters,
  previewExternalUpdate,
  resolveExternalUpdateAdapterForIntent,
  type ExternalUpdateAdapter,
  type ExternalUpdateAdapterInput,
  type ExternalUpdateAdapterTarget
} from "../src/external-update-adapter.js";
import type { UpdateIntent } from "../src/update-intents.js";

function buildIntent(overrides: Partial<UpdateIntent> = {}): UpdateIntent {
  return {
    id: "update_intent_test_1",
    adapterKind: "linear",
    targetExternalId: "linear-issue-1",
    intentType: "source_satisfied",
    payload: {
      goalState: "completed",
      evidenceType: "no_mistakes_complete",
      sourceExternalId: "linear-issue-1",
      sourceExternalKey: "NGX-1"
    },
    reason:
      "Goal completed with verification evidence (no_mistakes_complete); source item NGX-1 appears satisfied.",
    goalId: "goal_test_1",
    sourceItemId: "source_item_test_1",
    evidenceRecordId: "evidence_record_test_1",
    status: "pending",
    idempotencyKey: "linear:linear-issue-1:source_satisfied:goal_test_1",
    decisionReason: null,
    errorCode: null,
    errorMessage: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    appliedAt: null,
    skippedAt: null,
    canceledAt: null,
    ...overrides
  };
}

function buildTarget(overrides: Partial<ExternalUpdateAdapterTarget> = {}): ExternalUpdateAdapterTarget {
  return {
    adapterKind: "linear",
    externalId: "linear-issue-1",
    externalKey: "NGX-1",
    url: "https://linear.app/example/issue/NGX-1",
    title: "Example issue title",
    ...overrides
  };
}

function buildInput(
  overrides: Partial<ExternalUpdateAdapterInput> = {}
): ExternalUpdateAdapterInput {
  const base: ExternalUpdateAdapterInput = {
    intent: buildIntent(),
    target: buildTarget(),
    operator: { reason: "Operator confirmed Goal completion.", actor: "calvin" },
    policy: {
      intentApplyPolicy: "external_apply_allowed",
      allowStatusMutation: false
    }
  };
  return { ...base, ...overrides };
}

describe("external update adapter registry", () => {
  it("only registers the Linear adapter in M6", () => {
    expect(listExternalUpdateAdapterKinds()).toEqual(["linear"]);
    expect(BUILTIN_EXTERNAL_UPDATE_ADAPTER_KINDS).toEqual(["linear"]);
  });

  it("lists adapter summaries with their supported intent types", () => {
    const summaries = listExternalUpdateAdapters();
    expect(summaries).toEqual([
      { kind: "linear", supportedIntentTypes: ["source_satisfied"] }
    ]);
  });

  it("returns the linear adapter from getExternalUpdateAdapter", () => {
    const adapter = getExternalUpdateAdapter("linear");
    expect(adapter).toBeDefined();
    expect(adapter?.kind).toBe("linear");
    expect(adapter?.supportedIntentTypes).toContain("source_satisfied");
  });

  it("returns undefined for unknown adapter kinds", () => {
    expect(getExternalUpdateAdapter("github")).toBeUndefined();
  });

  it("resolves the linear adapter for an eligible source_satisfied intent", () => {
    const adapter = resolveExternalUpdateAdapterForIntent({
      adapterKind: "linear",
      intentType: "source_satisfied"
    });
    expect(adapter?.kind).toBe("linear");
  });

  it("returns undefined when no registered adapter supports the intent type", () => {
    expect(
      resolveExternalUpdateAdapterForIntent({
        adapterKind: "linear",
        intentType: "some_future_intent"
      })
    ).toBeUndefined();
  });

  it("returns undefined for adapter kinds that are not registered", () => {
    expect(
      resolveExternalUpdateAdapterForIntent({
        adapterKind: "github",
        intentType: "source_satisfied"
      })
    ).toBeUndefined();
  });
});

describe("external update adapter result taxonomy", () => {
  it("exposes the at-least taxonomy codes pinned by NGX-296", () => {
    for (const code of [
      "unsupported_intent_type",
      "target_missing",
      "auth_unavailable",
      "policy_denied",
      "external_conflict",
      "adapter_threw",
      "write_rejected",
      "write_timeout",
      "malformed_response",
      "validation_failed"
    ]) {
      expect(EXTERNAL_UPDATE_ADAPTER_ERROR_CODES).toContain(code);
    }
  });

  it("intentionally excludes reconciliation-specific codes (owned by NGX-300/NGX-301)", () => {
    const reconciliationCodes = [
      "post_apply_reconcile_failed",
      "post_apply_reconcile_mismatch"
    ];
    for (const code of reconciliationCodes) {
      expect(EXTERNAL_UPDATE_ADAPTER_ERROR_CODES).not.toContain(code);
    }
  });

  it("exposes the supported mutation kinds for previews", () => {
    expect(EXTERNAL_UPDATE_MUTATION_KINDS).toEqual([
      "comment",
      "status_transition"
    ]);
  });
});

describe("buildIdempotencyMarker", () => {
  it("produces a stable marker shape keyed off adapter, intent id, and payload", () => {
    const marker = buildIdempotencyMarker({
      adapterKind: "linear",
      intentId: "update_intent_1",
      payload: { foo: "bar" }
    });
    expect(marker.startsWith("momentum-intent:linear:update_intent_1:")).toBe(true);
  });

  it("returns the same marker for the same intent payload across calls", () => {
    const a = buildIdempotencyMarker({
      adapterKind: "linear",
      intentId: "update_intent_1",
      payload: { a: 1, b: "two" }
    });
    const b = buildIdempotencyMarker({
      adapterKind: "linear",
      intentId: "update_intent_1",
      payload: { b: "two", a: 1 }
    });
    expect(a).toBe(b);
  });

  it("returns different markers when intent id or payload differs", () => {
    const base = buildIdempotencyMarker({
      adapterKind: "linear",
      intentId: "update_intent_1",
      payload: { foo: "bar" }
    });
    const otherIntent = buildIdempotencyMarker({
      adapterKind: "linear",
      intentId: "update_intent_2",
      payload: { foo: "bar" }
    });
    const otherPayload = buildIdempotencyMarker({
      adapterKind: "linear",
      intentId: "update_intent_1",
      payload: { foo: "baz" }
    });
    expect(otherIntent).not.toBe(base);
    expect(otherPayload).not.toBe(base);
  });
});

describe("previewExternalUpdate", () => {
  it("returns a deterministic comment-only preview for an eligible source_satisfied intent", () => {
    const result = previewExternalUpdate(buildInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedMarker = buildIdempotencyMarker({
      adapterKind: "linear",
      intentId: "update_intent_test_1",
      payload: buildIntent().payload
    });

    expect(result.preview).toMatchObject({
      adapterKind: "linear",
      intentId: "update_intent_test_1",
      intentType: "source_satisfied",
      mutationKind: "comment",
      idempotencyMarker: expectedMarker
    });
    expect(result.preview.target).toMatchObject({
      adapterKind: "linear",
      externalId: "linear-issue-1",
      externalKey: "NGX-1"
    });
    expect(result.preview.summary).toContain("NGX-1");
    expect(result.preview.summary).toContain("source_satisfied");
    expect(result.preview.commentBody).toContain(expectedMarker);
    expect(result.preview.commentBody).toContain("Operator (calvin)");
    expect(result.preview.commentBody).toContain("Operator confirmed Goal completion.");
  });

  it("returns the same preview text and marker when called twice (no side effects)", () => {
    const input = buildInput();
    const a = previewExternalUpdate(input);
    const b = previewExternalUpdate(input);
    expect(a).toEqual(b);
  });

  it("never mutates the caller's intent or target inputs", () => {
    const intent = buildIntent();
    const target = buildTarget();
    const intentSnapshot = JSON.stringify(intent);
    const targetSnapshot = JSON.stringify(target);
    previewExternalUpdate(buildInput({ intent, target }));
    expect(JSON.stringify(intent)).toBe(intentSnapshot);
    expect(JSON.stringify(target)).toBe(targetSnapshot);
  });

  it("returns unsupported_adapter for unregistered adapter kinds", () => {
    const result = previewExternalUpdate(
      buildInput({
        intent: buildIntent({ adapterKind: "github", targetExternalId: "gh-1" }),
        target: buildTarget({ adapterKind: "github", externalId: "gh-1" })
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_adapter");
    expect(result.error).toContain("github");
  });

  it("returns unsupported_intent_type when the adapter does not support the intent type", () => {
    const result = previewExternalUpdate(
      buildInput({
        intent: buildIntent({ intentType: "some_future_intent" })
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_intent_type");
    expect(result.error).toContain("some_future_intent");
  });

  it("returns target_missing when the intent has no resolved target id", () => {
    const result = previewExternalUpdate(
      buildInput({
        intent: buildIntent({ targetExternalId: null }),
        target: buildTarget({ externalId: "" })
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("target_missing");
  });

  it("returns validation_failed when the operator reason is empty", () => {
    const result = previewExternalUpdate(
      buildInput({
        operator: { reason: "   ", actor: "calvin" }
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_failed");
  });

  it("returns validation_failed when intent target id does not match the resolved target", () => {
    const result = previewExternalUpdate(
      buildInput({
        target: buildTarget({ externalId: "linear-issue-other" })
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_failed");
  });

  it("wraps adapter exceptions as adapter_threw instead of leaking implementation detail", () => {
    const throwingAdapter: ExternalUpdateAdapter = {
      kind: "linear",
      supportedIntentTypes: ["source_satisfied"],
      preview: () => {
        throw new Error("write client exploded");
      }
    };

    const result = previewExternalUpdate(buildInput(), {
      adapters: new Map([["linear", throwingAdapter]])
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("adapter_threw");
    expect(result.error).toContain("write client exploded");
  });
});

describe("no external mutation side effects in boundary slice", () => {
  it("does not import any HTTP / network module from the boundary surface", async () => {
    const moduleSource = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../src/external-update-adapter.ts", import.meta.url),
        "utf8"
      )
    );
    // Anchored at line start, ignoring import lines, ensure no http/network
    // transport is wired up from the boundary module in this slice.
    const forbidden = [
      "linear-http-client",
      "node:http",
      "node:https",
      'from "http"',
      'from "https"',
      "fetch("
    ];
    for (const needle of forbidden) {
      expect(
        moduleSource.includes(needle),
        `boundary module should not reference ${needle}`
      ).toBe(false);
    }
  });
});

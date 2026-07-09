import { describe, expect, it } from "vitest";
import {
  createMomentumCommandRegistry,
  dispatchMomentumCommand,
  findMomentumCommandRoute,
  type MomentumCommandHandler
} from "../src/commands/index.js";

type TestParsed = {
  args: string[];
};

type TestIo = {
  writes: string[];
};

type TestDeps = Record<string, never>;

function makeHandler(label: string): MomentumCommandHandler<TestParsed, TestIo, TestDeps> {
  return (parsed, io) => {
    io.writes.push(`${label}:${parsed.args.join(" ")}`);
    return 40 + io.writes.length;
  };
}

describe("Momentum command registry", () => {
  it("uses an explicit command registry for representative top-level commands", () => {
    const registry = createMomentumCommandRegistry<TestParsed, TestIo, TestDeps>({
      doctor: makeHandler("doctor"),
      extraRoutes: [{ command: "workflow", run: makeHandler("workflow") }]
    });

    expect(registry.map((route) => route.command)).toEqual(["doctor", "workflow"]);
    expect(findMomentumCommandRoute(registry, ["doctor"])).toMatchObject({ command: "doctor" });
    expect(findMomentumCommandRoute(registry, ["workflow", "status"])).toMatchObject({ command: "workflow" });
    expect(findMomentumCommandRoute(registry, ["status", "goal-1"])).toBeNull();
  });

  it("dispatches matching commands to their registered handlers without changing argv", async () => {
    const registry = createMomentumCommandRegistry<TestParsed, TestIo, TestDeps>({
      doctor: makeHandler("doctor"),
      extraRoutes: [{ command: "workflow", run: makeHandler("workflow") }]
    });
    const io: TestIo = { writes: [] };
    const deps: TestDeps = {};

    await expect(
      dispatchMomentumCommand(registry, {
        parsed: { args: ["doctor", "--json"] },
        io,
        deps
      })
    ).resolves.toEqual({ handled: true, code: 41 });
    await expect(
      dispatchMomentumCommand(registry, {
        parsed: { args: ["workflow", "status"] },
        io,
        deps
      })
    ).resolves.toEqual({ handled: true, code: 42 });
    await expect(
      dispatchMomentumCommand(registry, {
        parsed: { args: ["logs", "goal-1"] },
        io,
        deps
      })
    ).resolves.toEqual({ handled: false });

    expect(io.writes).toEqual(["doctor:doctor --json", "workflow:workflow status"]);
  });

  it("rejects duplicate explicit route declarations", () => {
    expect(() =>
      createMomentumCommandRegistry<TestParsed, TestIo, TestDeps>({
        doctor: makeHandler("first"),
        extraRoutes: [{ command: "doctor", run: makeHandler("second") }]
      })
    ).toThrow(/Duplicate Momentum command route: doctor/);
  });
});

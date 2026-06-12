export type MomentumCommandHandler<TParsed, TIo, TDeps> = (
  parsed: TParsed,
  io: TIo,
  deps: TDeps
) => number | Promise<number>;

export type MomentumCommandRoute<TParsed, TIo, TDeps> = {
  command: string;
  run: MomentumCommandHandler<TParsed, TIo, TDeps>;
};

export type MomentumCommandRegistry<TParsed, TIo, TDeps> = ReadonlyArray<
  MomentumCommandRoute<TParsed, TIo, TDeps>
>;

export type MomentumCommandRegistryHandlers<TParsed, TIo, TDeps> = {
  doctor: MomentumCommandHandler<TParsed, TIo, TDeps>;
  status: MomentumCommandHandler<TParsed, TIo, TDeps>;
  extraRoutes?: MomentumCommandRoute<TParsed, TIo, TDeps>[];
};

export type MomentumCommandDispatchInput<TParsed extends { args: string[] }, TIo, TDeps> = {
  parsed: TParsed;
  io: TIo;
  deps: TDeps;
};

export type MomentumCommandDispatchResult =
  | { handled: true; code: number }
  | { handled: false };

export function createMomentumCommandRegistry<
  TParsed extends { args: string[] },
  TIo,
  TDeps
>(
  handlers: MomentumCommandRegistryHandlers<TParsed, TIo, TDeps>
): MomentumCommandRegistry<TParsed, TIo, TDeps> {
  return assertUniqueRoutes([
    { command: "doctor", run: handlers.doctor },
    { command: "status", run: handlers.status },
    ...(handlers.extraRoutes ?? [])
  ]);
}

export function findMomentumCommandRoute<TParsed, TIo, TDeps>(
  registry: MomentumCommandRegistry<TParsed, TIo, TDeps>,
  args: string[]
): MomentumCommandRoute<TParsed, TIo, TDeps> | null {
  const command = args[0];
  if (!command) return null;
  return registry.find((route) => route.command === command) ?? null;
}

export async function dispatchMomentumCommand<
  TParsed extends { args: string[] },
  TIo,
  TDeps
>(
  registry: MomentumCommandRegistry<TParsed, TIo, TDeps>,
  input: MomentumCommandDispatchInput<TParsed, TIo, TDeps>
): Promise<MomentumCommandDispatchResult> {
  const route = findMomentumCommandRoute(registry, input.parsed.args);
  if (!route) return { handled: false };
  const code = await route.run(input.parsed, input.io, input.deps);
  return { handled: true, code };
}

function assertUniqueRoutes<TParsed, TIo, TDeps>(
  routes: MomentumCommandRoute<TParsed, TIo, TDeps>[]
): MomentumCommandRegistry<TParsed, TIo, TDeps> {
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.command)) {
      throw new Error(`Duplicate Momentum command route: ${route.command}`);
    }
    seen.add(route.command);
  }
  return routes;
}

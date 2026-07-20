export default {
  name: "fixture-executor",
  configSchema: {
    type: "object",
    properties: {
      message: { type: "string", minLength: 1 },
      turns: { type: "integer", minimum: 1 },
      blockMs: { type: "integer", minimum: 0 },
    },
    required: ["message"],
    additionalProperties: false,
  },
  tick(context) {
    const blockUntil = Date.now() + (context.config.blockMs ?? 0);
    while (Date.now() < blockUntil) {
      // Deliberately occupy the main event loop to prove lease heartbeats run
      // independently from synchronous third-party executor work.
    }
    const attempt = context.state.attempt;
    const index = context.state.rounds.length + 1;
    const round = context.envelope.startRound({
      roundId: `${attempt.attemptId}::round-${index}`,
      attemptId: attempt.attemptId,
      workflowRunId: attempt.workflowRunId,
      stepRunId: attempt.stepRunId,
      stepKey: attempt.stepKey,
      executorFamily: attempt.executorFamily,
      attempt: attempt.attempt,
      roundIndex: context.state.rounds.length,
      state: "capturing_result",
      agentProvider: null,
      model: null,
      effort: null,
      inputDigest: null,
      resultDigest: null,
      artifactRoot: null,
      logPaths: [],
      summary: context.config.message,
      keyChanges: [],
      keyLearnings: [],
      remainingWork: [],
      changedFiles: [],
      verificationStatus: "passed",
      commitSha: null,
    });
    const complete = index >= (context.config.turns ?? 1);
    return {
      roundId: round.roundId,
      recommendation: complete ? "complete" : "continue",
      recommendedRoundState: "succeeded",
      recommendedAttemptState: complete ? "succeeded" : "running",
      recoveryCode: null,
      humanGate: null,
      reason: complete
        ? "Fixture executor completed its bounded turn."
        : "Fixture executor recommends another bounded turn.",
    };
  },
};

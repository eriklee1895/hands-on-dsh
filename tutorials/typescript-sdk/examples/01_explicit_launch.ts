import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { parseCommonArguments, printHelp, runCli, sanitizedJson } from "../src/cli.ts";
import { withOwnerDeadline } from "../src/owner-deadline.ts";
import { requireCompletedTurn } from "../src/run-outcome.ts";
import { cleanupRuntimeState, resolveRuntimeLaunch } from "../src/runtime-launch.ts";

await runCli(async () => {
  const args = parseCommonArguments(process.argv.slice(2));
  if (args.help) {
    printHelp("01_explicit_launch.ts", "显式验证并启动 DSH runtime，完成一次高层 SDK 调用。");
    return;
  }

  const launch = await resolveRuntimeLaunch({
    exampleName: "01-explicit-launch",
    ...(args.patch === undefined ? {} : { patches: [args.patch] }),
  });
  let harness: DeepSeekHarness | undefined;

  try {
    const owner = new DeepSeekHarness({
      ...launch.options,
      cwd: launch.state.workspace,
      provider: launch.provider,
      model: launch.model,
    });
    harness = owner;
    const result = await withOwnerDeadline("example 01", args.deadlineMs, owner, () =>
      owner.run(args.prompt ?? "请只用文字回答：TypeScript SDK 已连接。不要调用工具。", {
        sessionId: args.sessionId ?? "typescript-explicit-launch",
      }),
    );
    requireCompletedTurn(result.events);
    process.stdout.write(
      `${sanitizedJson(
        {
          result: {
            sessionId: result.sessionId,
            finalResponse: result.finalResponse,
            eventCount: result.events.length,
          },
        },
        launch.state,
        process.env.DEEPSEEK_API_KEY,
      )}\n`,
    );
  } finally {
    if (harness !== undefined) await harness.close();
    await cleanupRuntimeState(launch.state);
  }
});

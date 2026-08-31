import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { parseCommonArguments, printHelp, runCli, sanitizedJson } from "../src/cli.ts";
import { withOwnerDeadline } from "../src/owner-deadline.ts";
import { cleanupRuntimeState, resolveRuntimeLaunch } from "../src/runtime-launch.ts";

await runCli(async () => {
  const args = parseCommonArguments(process.argv.slice(2));
  if (args.help) {
    printHelp("01_explicit_launch.ts", "显式验证并启动 DSH runtime，完成一次高层 SDK 调用。");
    return;
  }

  const launch = await resolveRuntimeLaunch({
    exampleName: "01-explicit-launch",
    ...(args.sourceRoot === undefined ? {} : { sourceRoot: args.sourceRoot }),
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
  });
  const harness = new DeepSeekHarness({
    launch: launch.options,
    cwd: launch.state.workspace,
    provider: launch.provider,
    model: launch.model,
  });

  try {
    const result = await withOwnerDeadline("example 01", args.deadlineMs, harness, () =>
      harness.run(args.prompt ?? "请只用文字回答：TypeScript SDK 已连接。不要调用工具。", {
        sessionId: args.sessionId ?? "typescript-explicit-launch",
      }),
    );
    process.stdout.write(
      `${sanitizedJson(
        {
          source: {
            tag: launch.source.tag,
            revision: launch.source.revision,
            version: launch.source.version,
          },
          result: {
            sessionId: result.sessionId,
            finalResponse: result.finalResponse,
            eventCount: result.events.length,
          },
        },
        launch.source,
        launch.state,
        process.env.DEEPSEEK_API_KEY,
      )}\n`,
    );
  } finally {
    await harness.close();
    await cleanupRuntimeState(launch.state);
  }
});

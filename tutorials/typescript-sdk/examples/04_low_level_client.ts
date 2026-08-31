import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";
import { parseCommonArguments, printHelp, runCli, sanitizedJson } from "../src/cli.ts";
import { runLowLevelPrompt } from "../src/low-level-run.ts";
import { withOwnerDeadline } from "../src/owner-deadline.ts";
import { cleanupRuntimeState, resolveRuntimeLaunch } from "../src/runtime-launch.ts";

await runCli(async () => {
  const args = parseCommonArguments(process.argv.slice(2));
  if (args.help) {
    printHelp(
      "04_low_level_client.ts",
      "显式使用 HarnessClient 完成 initialize、subscribe、prompt、receipt-to-idle 与关闭。",
    );
    return;
  }

  const launch = await resolveRuntimeLaunch({
    exampleName: "04-low-level-client",
    ...(args.sourceRoot === undefined ? {} : { sourceRoot: args.sourceRoot }),
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
  });
  const client = new HarnessClient(launch.options);

  try {
    const result = await withOwnerDeadline("example 04", args.deadlineMs, client, async () => {
      client.start();
      const initialized = await client.initialize({
        cwd: launch.state.workspace,
        provider: launch.provider,
        model: launch.model,
      });
      const run = await runLowLevelPrompt(
        client,
        args.sessionId ?? "typescript-low-level",
        args.prompt ?? "请只用文字回答：底层 TypeScript client 已连接。不要调用工具。",
      );
      return { initialized, run };
    });
    process.stdout.write(
      `${sanitizedJson(
        {
          serverInfo: result.initialized.serverInfo,
          receipt: result.run.messageId,
          finalResponse: result.run.finalResponse,
          notificationCount: result.run.notifications.length,
        },
        launch.source,
        launch.state,
        process.env.DEEPSEEK_API_KEY,
      )}\n`,
    );
  } finally {
    await client.close();
    await cleanupRuntimeState(launch.state);
  }
});

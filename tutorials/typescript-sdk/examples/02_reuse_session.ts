import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { parseCommonArguments, printHelp, runCli, sanitizedJson } from "../src/cli.ts";
import { withOwnerDeadline } from "../src/owner-deadline.ts";
import { cleanupRuntimeState, resolveRuntimeLaunch } from "../src/runtime-launch.ts";

await runCli(async () => {
  const args = parseCommonArguments(process.argv.slice(2));
  if (args.help) {
    printHelp(
      "02_reuse_session.ts",
      "复用同一个 runtime 进程和 session，连续运行两个 turn。",
      "额外选项：--second-prompt <文本>",
    );
    return;
  }

  const launch = await resolveRuntimeLaunch({
    exampleName: "02-reuse-session",
    ...(args.sourceRoot === undefined ? {} : { sourceRoot: args.sourceRoot }),
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
  });
  const harness = new DeepSeekHarness({
    launch: launch.options,
    cwd: launch.state.workspace,
    provider: launch.provider,
    model: launch.model,
  });
  const session = harness.session(args.sessionId ?? "typescript-reused-session");

  try {
    const first = await withOwnerDeadline("example 02 turn 1", args.deadlineMs, harness, () =>
      session.run(args.prompt ?? "记住代号 amber，只用文字确认，不要调用工具。"),
    );
    const second = await withOwnerDeadline("example 02 turn 2", args.deadlineMs, harness, () =>
      session.run(args.secondPrompt ?? "刚才的代号是什么？只回答代号，不要调用工具。"),
    );
    process.stdout.write(
      `${sanitizedJson(
        {
          sessionId: session.id,
          sameRuntimeOwner: true,
          turns: [first.finalResponse, second.finalResponse],
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

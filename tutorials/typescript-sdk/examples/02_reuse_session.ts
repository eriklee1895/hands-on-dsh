import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { parseCommonArguments, printHelp, runCli, sanitizedJson } from "../src/cli.ts";
import { withOwnerDeadline } from "../src/owner-deadline.ts";
import { requireCompletedTurn, requireRememberedNonce } from "../src/run-outcome.ts";
import { cleanupRuntimeState, resolveRuntimeLaunch } from "../src/runtime-launch.ts";

await runCli(async () => {
  const args = parseCommonArguments(process.argv.slice(2), true);
  if (args.help) {
    printHelp(
      "02_reuse_session.ts",
      "复用同一个 runtime 进程和 session，连续运行两个 turn。",
      "额外选项：--second-prompt <文本>、--nonce <代号，默认 amber>",
    );
    return;
  }

  const launch = await resolveRuntimeLaunch({
    exampleName: "02-reuse-session",
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
    const session = owner.session(args.sessionId ?? "typescript-reused-session");
    const nonce = args.nonce ?? "amber";
    const first = await withOwnerDeadline("example 02 turn 1", args.deadlineMs, owner, () =>
      session.run(args.prompt ?? `记住代号 ${nonce}，只用文字确认，不要调用工具。`),
    );
    requireCompletedTurn(first.events);
    const second = await withOwnerDeadline("example 02 turn 2", args.deadlineMs, owner, () =>
      session.run(args.secondPrompt ?? "刚才的代号是什么？只回答代号原文，不要调用工具。"),
    );
    requireCompletedTurn(second.events);
    requireRememberedNonce(second.finalResponse, nonce);
    process.stdout.write(
      `${sanitizedJson(
        {
          sessionId: session.id,
          sameRuntimeOwner: true,
          turns: [first.finalResponse, second.finalResponse],
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

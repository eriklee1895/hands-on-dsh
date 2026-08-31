import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { parseCommonArguments, printHelp, runCli, sanitizedJson } from "../src/cli.ts";
import { NotificationProjection } from "../src/notification-projection.ts";
import { withOwnerDeadline } from "../src/owner-deadline.ts";
import { cleanupRuntimeState, resolveRuntimeLaunch } from "../src/runtime-launch.ts";

await runCli(async () => {
  const args = parseCommonArguments(process.argv.slice(2));
  if (args.help) {
    printHelp(
      "03_notification_stream.ts",
      "投影根 session 文本与工具、subagent、生命周期事件，并验证真实文件字节。",
    );
    return;
  }

  const launch = await resolveRuntimeLaunch({
    exampleName: "03-notification-stream",
    ...(args.sourceRoot === undefined ? {} : { sourceRoot: args.sourceRoot }),
    ...(args.configPath === undefined ? {} : { configPath: args.configPath }),
  });
  const sessionId = args.sessionId ?? "typescript-notification-stream";
  const projection = new NotificationProjection(sessionId);
  const harness = new DeepSeekHarness({
    launch: launch.options,
    cwd: launch.state.workspace,
    provider: launch.provider,
    model: launch.model,
  });
  const proofPath = join(launch.state.workspace, "dsh-typescript-proof.txt");
  const proofBytes = Buffer.from("hands-on-dsh TypeScript SDK proof\n", "utf8");

  try {
    await access(proofPath).then(
      () => {
        throw new Error("proof file unexpectedly existed before the turn");
      },
      () => undefined,
    );
    const userContext = args.prompt === undefined ? "" : `\n附加要求：${args.prompt}`;
    const prompt = `使用可用工具创建文件 ${proofPath}，内容必须逐字节等于：hands-on-dsh TypeScript SDK proof\\n。完成后简短确认。${userContext}`;
    const result = await withOwnerDeadline("example 03", args.deadlineMs, harness, () =>
      harness.run(prompt, {
        sessionId,
        onNotification: (notification) => projection.accept(notification),
      }),
    );
    const actual = await readFile(proofPath);
    if (!actual.equals(proofBytes))
      throw new Error("proof file bytes did not match the expected artifact");
    process.stdout.write(
      `${sanitizedJson(
        {
          result: result.finalResponse,
          projection: projection.snapshot(),
          proof: { verified: true, byteLength: actual.byteLength },
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

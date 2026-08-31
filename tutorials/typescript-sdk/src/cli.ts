import { isAbsolute } from "node:path";
import type { RuntimeState, SourceEvidence } from "./runtime-launch.ts";

export interface CommonArguments {
  readonly help: boolean;
  readonly prompt?: string;
  readonly secondPrompt?: string;
  readonly sessionId?: string;
  readonly deadlineMs: number;
  readonly sourceRoot?: string;
  readonly configPath?: string;
}

export function parseCommonArguments(argv: string[]): CommonArguments {
  const values: Record<string, string> = {};
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === undefined || !argument.startsWith("--"))
      throw new Error(`未知参数：${argument ?? ""}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} 缺少值`);
    values[argument] = value;
    index += 1;
  }
  const deadline =
    values["--deadline-ms"] === undefined ? 120_000 : Number(values["--deadline-ms"]);
  if (!Number.isSafeInteger(deadline) || deadline <= 0)
    throw new Error("--deadline-ms 必须是正整数");
  return {
    help,
    deadlineMs: deadline,
    ...(values["--prompt"] === undefined ? {} : { prompt: values["--prompt"] }),
    ...(values["--second-prompt"] === undefined ? {} : { secondPrompt: values["--second-prompt"] }),
    ...(values["--session"] === undefined ? {} : { sessionId: values["--session"] }),
    ...(values["--source-root"] === undefined ? {} : { sourceRoot: values["--source-root"] }),
    ...(values["--config"] === undefined ? {} : { configPath: values["--config"] }),
  };
}

export function printHelp(example: string, description: string, extra = ""): void {
  process.stdout.write(`用法：node --import tsx examples/${example} [选项]\n\n${description}\n\n`);
  process.stdout.write(
    "选项：\n  --prompt <文本>\n  --session <ID>\n  --deadline-ms <毫秒>\n  --source-root <DSH 源码绝对路径>\n  --config <upstream tmp 中的 gitignored cordis.yml 绝对路径>\n  -h, --help\n",
  );
  if (extra !== "") process.stdout.write(`${extra}\n`);
}

function redactText(
  text: string,
  source: SourceEvidence,
  state: RuntimeState,
  key: string | undefined,
): string {
  let output = text;
  for (const secret of [source.root, state.root, key]) {
    if (secret !== undefined && secret !== "") output = output.replaceAll(secret, "<redacted>");
  }
  return output.replaceAll(/\/Users\/[^\s"']+/g, "<local-path>");
}

export function sanitizedJson(
  value: unknown,
  source: SourceEvidence,
  state: RuntimeState,
  key: string | undefined,
): string {
  return redactText(JSON.stringify(value, undefined, 2), source, state, key);
}

export function failureKind(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function sanitizedFailure(error: unknown): string {
  const key = process.env.DEEPSEEK_API_KEY;
  let message = error instanceof Error ? error.message : String(error);
  if (key !== undefined && key !== "") message = message.replaceAll(key, "<redacted>");
  const knownRoots = [
    process.cwd(),
    process.env.DSH_SOURCE_ROOT,
    ...process.argv.filter((value) => isAbsolute(value)),
  ]
    .filter((value): value is string => value !== undefined && value !== "")
    .sort((left, right) => right.length - left.length);
  for (const root of knownRoots) message = message.replaceAll(root, "<local-path>");
  message = message
    .replaceAll(/\/(?:Users|Volumes|home|mnt)\/[^\s"']+/g, "<local-path>")
    .replaceAll(/\/(?:private\/var|var\/folders)\/[^\s"']+/g, "<local-path>");
  return JSON.stringify({ error: failureKind(error), message });
}

export async function runCli(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${sanitizedFailure(error)}\n`);
    process.exitCode = 1;
  }
}

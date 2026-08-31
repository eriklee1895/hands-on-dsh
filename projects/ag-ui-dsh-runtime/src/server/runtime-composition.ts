export const RUNTIME_BARE_PLUGINS = {
  sdkServer: "@deepseek-ai/dsh-sdk-jsonrpc-server",
  llmDeepSeek: "@deepseek-ai/dsh-llm-deepseek",
  sandboxLocal: "@deepseek-ai/dsh-sandbox-local",
  sandboxPolicy: "@deepseek-ai/dsh-sandbox-policy",
  subprocessLocal: "@deepseek-ai/dsh-subprocess-local",
  terminal: "@deepseek-ai/dsh-terminal",
  terminalBash: "@deepseek-ai/dsh-terminal-bash",
  fsLocal: "@deepseek-ai/dsh-fs-local",
  agentSpine: "@deepseek-ai/dsh-agent-spine-demo",
  sessionPersistence: "@deepseek-ai/dsh-session-persistence-jsonl",
} as const;

export const RUNTIME_BARE_PLUGIN_SEEDS = Object.values(RUNTIME_BARE_PLUGINS);

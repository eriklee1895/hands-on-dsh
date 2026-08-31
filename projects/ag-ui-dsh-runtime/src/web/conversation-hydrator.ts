import { HttpAgent } from "@ag-ui/client";
import type { ConversationSnapshot } from "./api-client.ts";

export type { ConversationSnapshot } from "./api-client.ts";

export interface HydratedConversation {
  snapshot: ConversationSnapshot;
  agent: HttpAgent;
}

type SnapshotFetcher = (
  conversationId: string,
  signal: AbortSignal,
) => Promise<ConversationSnapshot>;
type AgentFactory = (conversationId: string) => HttpAgent;

export class ConversationHydrator {
  private generation = 0;
  private controller: AbortController | undefined;
  private readonly fetchSnapshot: SnapshotFetcher;
  private readonly createAgent: AgentFactory;

  constructor(input: { fetchSnapshot: SnapshotFetcher; createAgent?: AgentFactory }) {
    this.fetchSnapshot = input.fetchSnapshot;
    this.createAgent =
      input.createAgent ??
      ((conversationId) =>
        new HttpAgent({
          url: "/api/ag-ui",
          agentId: "dsh",
          threadId: conversationId,
        }));
  }

  async select(conversationId: string): Promise<HydratedConversation | undefined> {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    let snapshot: ConversationSnapshot;
    try {
      snapshot = await this.fetchSnapshot(conversationId, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return undefined;
      throw error;
    }
    if (controller.signal.aborted || generation !== this.generation) return undefined;
    const agent = this.createAgent(conversationId);
    agent.setMessages(snapshot.messages);
    if (controller.signal.aborted || generation !== this.generation) return undefined;
    return { snapshot, agent };
  }

  dispose(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
  }
}

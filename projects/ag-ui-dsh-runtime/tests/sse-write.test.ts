import { EventEmitter } from "node:events";
import { describe, expect, test } from "vitest";
import { writeSseChunk } from "../src/server/app.ts";

class Sink extends EventEmitter {
  destroyed = false;
  writableEnded = false;

  constructor(private readonly acceptsImmediately: boolean) {
    super();
  }

  write(_chunk: string): boolean {
    return this.acceptsImmediately;
  }
}

function expectNoListeners(sink: Sink) {
  for (const event of ["drain", "close", "error"]) expect(sink.listenerCount(event)).toBe(0);
}

describe("SSE backpressure writer", () => {
  test("returns immediately without installing listeners when write accepts", async () => {
    const sink = new Sink(true);
    await writeSseChunk(sink, "data: {}\n\n", new AbortController().signal);
    expectNoListeners(sink);
  });

  test("waits for drain and removes every listener", async () => {
    const sink = new Sink(false);
    const pending = writeSseChunk(sink, "data: {}\n\n", new AbortController().signal);
    sink.emit("drain");
    await expect(pending).resolves.toBeUndefined();
    expectNoListeners(sink);
  });

  test.each(["close", "error"] as const)(
    "rejects on %s and removes every listener",
    async (event) => {
      const sink = new Sink(false);
      const pending = writeSseChunk(sink, "data: {}\n\n", new AbortController().signal);
      if (event === "error") sink.emit(event, new Error("socket failed"));
      else sink.emit(event);
      await expect(pending).rejects.toThrow(event === "error" ? /socket failed/ : /closed/);
      expectNoListeners(sink);
    },
  );

  test("rejects an already destroyed sink without adding listeners", async () => {
    const sink = new Sink(false);
    sink.destroyed = true;
    await expect(writeSseChunk(sink, "data: {}\n\n", new AbortController().signal)).rejects.toThrow(
      /closed/,
    );
    expectNoListeners(sink);
  });
});

import { expect, test } from "vitest";
import {
  assertExactNonceRecall,
  lastRootCommittedText,
} from "../scripts/real-package-assertions.mjs";

const assistant = (sessionId, text) => ({
  channel: "raw-dsh",
  type: "session.event",
  payload: {
    method: "session.event",
    params: {
      sessionId,
      event: {
        type: "assistant/message",
        data: { message: { content: [{ type: "text", text }] } },
      },
    },
  },
});

test("uses only the last root committed assistant message", () => {
  const nonce = "NEXACT123";
  const rows = [
    assistant("root", nonce),
    assistant("child", "child text"),
    assistant("root", `The nonce is ${nonce}`),
  ];
  expect(lastRootCommittedText(rows, "root")).toBe(`The nonce is ${nonce}`);
  expect(() => assertExactNonceRecall(rows, "root", nonce)).toThrow(/exact nonce/);
  expect(() => assertExactNonceRecall([assistant("root", "NWRONG")], "root", nonce)).toThrow(
    /exact nonce/,
  );
  expect(assertExactNonceRecall([assistant("root", ` ${nonce}\n`)], "root", nonce)).toBe(nonce);
});

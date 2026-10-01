import assert from "node:assert/strict";
import type { Color } from "./fixture.ts";
export function verifyAnswer(answer: string, expected: readonly (readonly Color[])[]): void {
  assert.deepEqual(
    JSON.parse(answer),
    expected,
    "vision answer must match every cell of every image",
  );
}

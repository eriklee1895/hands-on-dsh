import { it, expect } from "vitest";
import { verifyAnswer } from "../src/verify.ts";
const expected = [
  ["red", "blue", "green", "yellow"],
  ["yellow", "green", "red", "blue"],
] as const;
it("accepts exact image order and refuses guesses with wrong cells", () => {
  expect(() => verifyAnswer(JSON.stringify(expected), expected)).not.toThrow();
  expect(() => verifyAnswer(JSON.stringify([expected[1], expected[0]]), expected)).toThrow();
});
it("refuses missing images and prose instead of the required JSON", () => {
  expect(() => verifyAnswer(JSON.stringify([expected[0]]), expected)).toThrow();
  expect(() => verifyAnswer("The images look colourful", expected)).toThrow();
});

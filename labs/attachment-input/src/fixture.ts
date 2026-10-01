/** Pixel-only colour grids; the expected order is kept outside the model prompt. */
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import sharp from "sharp";
export const COLORS = ["red", "green", "blue", "yellow"] as const;
export type Color = (typeof COLORS)[number];
const RGB: Record<Color, readonly number[]> = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
};
export function shuffledColors(): Color[] {
  const colors = [...COLORS];
  for (let i = colors.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [colors[i], colors[j]] = [colors[j]!, colors[i]!];
  }
  return colors;
}
export async function grid(order: readonly Color[], width = 512, height = 512): Promise<Buffer> {
  assert.deepEqual([...order].sort(), [...COLORS].sort());
  assert.ok(width % 2 === 0 && height % 2 === 0);
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const color = RGB[order[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)]!];
      const offset = (y * width + x) * 3;
      data[offset] = color[0]!;
      data[offset + 1] = color[1]!;
      data[offset + 2] = color[2]!;
    }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

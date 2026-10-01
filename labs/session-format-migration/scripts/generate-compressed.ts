import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { constants, zstdCompress } from "node:zlib";

// The pinned backend's frame recipe: checksummed Zstandard header frame, then
// independently decodable checksummed event-batch frame. Source rows are the
// lab's explicitly handwritten V1/V3 synthetic fixtures, not a release capture.
const compress = promisify(zstdCompress);
const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

for (const name of ["v1", "v3"] as const) {
  const source = join(import.meta.dirname, "..", "fixtures", `synthetic-${name}.jsonl`);
  const rows = await readFile(source, "utf8");
  const firstNewline = rows.indexOf("\n");
  if (firstNewline < 0 || firstNewline === rows.length - 1) {
    throw new Error(`${name}: expected nonempty historical body`);
  }
  const header = rows.slice(0, firstNewline + 1);
  const events = rows.slice(firstNewline + 1);
  await writeFile(
    `${source}.zstd`,
    Buffer.concat([await compress(header, options), await compress(events, options)]),
  );
}

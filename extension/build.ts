import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";

const root = import.meta.dirname;
const out = join(root, "dist");

function png(size: number): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 4;
      const edge = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
      raw[i] = edge ? 20 : 36;
      raw[i + 1] = edge ? 90 : 140;
      raw[i + 2] = edge ? 60 : 90;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const name = Buffer.from(type);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
    return Buffer.concat([len, name, data, crc]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const entries = ["content/index.ts", "content/page-hook.ts", "background/sw.ts", "offscreen/ner.ts", "popup/popup.ts"];
const result = await Bun.build({
  entrypoints: entries.map((e) => join(root, "src", e)),
  outdir: out,
  target: "browser",
  format: "esm",
  naming: "[dir]/[name].[ext]",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("extension bundle failed");
}

await Bun.write(join(out, "offscreen.html"), await readFile(join(root, "src/offscreen/offscreen.html")));
await Bun.write(join(out, "popup.html"), await readFile(join(root, "src/popup/popup.html")));
await Bun.write(join(out, "popup.css"), await readFile(join(root, "src/popup/popup.css")));

const iconDir = join(root, "icons");
await mkdir(iconDir, { recursive: true });
for (const size of [16, 48, 128]) {
  await writeFile(join(iconDir, `icon${size}.png`), png(size));
}

const ortPkg = join(root, "..", "node_modules", "onnxruntime-web", "dist");
const ortOut = join(out, "ort");
await mkdir(ortOut, { recursive: true });
const { readdir } = await import("node:fs/promises");
for (const name of await readdir(ortPkg)) {
  if (name.endsWith(".wasm") || name.endsWith(".mjs")) {
    await cp(join(ortPkg, name), join(ortOut, name));
  }
}

try {
  const chosen = JSON.parse(await readFile(join(root, "models", "chosen.json"), "utf8")) as { id?: string };
  console.log(`model ${chosen.id ?? "unset"}`);
} catch {
  console.warn("models/chosen.json missing; on-device NER will fail closed until scripts/spike-ner.ts runs");
}

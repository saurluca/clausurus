import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dirname;
const out = join(root, "dist");

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

const ortPkg = join(root, "..", "node_modules", "onnxruntime-web", "dist");
const ortOut = join(out, "ort");
await rm(ortOut, { recursive: true, force: true });
await mkdir(ortOut, { recursive: true });
// ponytail: transformers requests this pair when wasmPaths is a directory prefix
for (const name of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) {
  await cp(join(ortPkg, name), join(ortOut, name));
}

try {
  const chosen = JSON.parse(await readFile(join(root, "models", "chosen.json"), "utf8")) as { id?: string };
  console.log(`model ${chosen.id ?? "unset"}`);
} catch {
  console.warn("models/chosen.json missing; on-device NER will fail closed");
}

import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const source = dirname(require.resolve("pdfjs-dist/package.json"));
const target = fileURLToPath(new URL("../public/pdfjs/", import.meta.url));
await mkdir(target, { recursive: true });
await Promise.all([
  cp(join(source, "build/pdf.worker.min.mjs"), join(target, "pdf.worker.min.mjs")),
  cp(join(source, "LICENSE"), join(target, "LICENSE")),
  ...["cmaps", "standard_fonts", "iccs", "wasm"].map((directory) =>
    cp(join(source, directory), join(target, directory), { recursive: true })),
]);

import type { NextConfig } from "next";
import { dirname, relative, sep } from "node:path";

const entityDecoder = require.resolve("decode-named-character-reference", {
  paths: [dirname(require.resolve("micromark-util-decode-string"))],
});

// Static export is shared by the desktop shell and the local Axum prototype.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Share the DOM-free Markdown entity decoder with the analysis worker.
  turbopack: { resolveAlias: { "decode-named-character-reference": "./" + relative(__dirname, entityDecoder).split(sep).join("/") } },
};

export default nextConfig;


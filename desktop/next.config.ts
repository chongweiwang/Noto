import type { NextConfig } from "next";

// Static export is shared by the desktop shell and the local Axum prototype.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;


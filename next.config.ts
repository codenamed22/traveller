import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  distDir: process.env.PLAYWRIGHT_TEST === "1" ? ".next/e2e" : ".next",
  serverExternalPackages: ["highs"],
  outputFileTracingIncludes: { "/api/plan": ["./node_modules/highs/**/*.wasm"] },
};

export default nextConfig;
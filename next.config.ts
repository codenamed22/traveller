import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["highs"],
  outputFileTracingIncludes: { "/api/plan": ["./node_modules/highs/**/*.wasm"] },
};

export default nextConfig;
import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
};
export default config;

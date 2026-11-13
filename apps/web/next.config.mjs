// Static export: the web app is hosted apart from the API (T-2), with no server code.
/** @type {import("next").NextConfig} */
const config = {
  output: "export",
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  // Always defined, so the demo branch in src/demo/load.ts is a constant false in a production build
  // and webpack never emits the demo world (scripts/verify-build.mjs fails the build if it did).
  env: { NEXT_PUBLIC_DEMO: process.env.NEXT_PUBLIC_DEMO === "1" ? "1" : "0" },
  // The workspace packages ship TypeScript source.
  transpilePackages: ["@veylo/contract", "@veylo/core", "@veylo/intents", "@veylo/chains"],
  // The repo uses NodeNext ".js" imports of ".ts" files; webpack maps them (Turbopack can't yet).
  webpack(config) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};
export default config;

/**
 * Bundle the TUI plugin (`src/tui/index.tsx`) into `dist/tui.js`.
 *
 * The server plugin (`./` export) is plain TypeScript consumed directly by the
 * opencode server. The TUI plugin (`./tui` export) is a SolidJS component that
 * must be bundled for the opencode TUI process, mirroring opencode-visual-cache.
 */
import * as esbuild from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"

await esbuild.build({
  entryPoints: ["src/tui/index.tsx"],
  outfile: "dist/tui.js",
  format: "esm",
  platform: "node",
  bundle: true,
  external: ["@opencode-ai/*", "@opentui/*", "solid-js"],
  plugins: [solidPlugin({ solid: { moduleName: "@opentui/solid", generate: "universal" } })],
})

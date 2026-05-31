import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/api.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: "inline",
})

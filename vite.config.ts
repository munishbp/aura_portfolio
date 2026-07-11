import { defineConfig } from "vite";

// Relative base: the built app works at any path — GitHub Pages
// (munishbp.github.io/aura_portfolio/), an iframe on the portfolio site,
// or copied wholesale into another static host.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", assetsInlineLimit: 0 },
});

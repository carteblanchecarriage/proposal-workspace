import { defineConfig, loadEnv } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { devApi } from "./dev-api-plugin";
import { pdfjsAssets } from "./pdfjs-assets-plugin";
import { siteFiles } from "./site-files-plugin";
import { guides } from "./guide-plugin";

export default defineConfig(({ mode }) => {
  // Expose server-only secrets (no VITE_ prefix) to the local API handlers.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));
  // Svelte compiles the schedule screens (src/schedule/), which are loaded only when a schedule opens.
  return {
    plugins: [devApi(), svelte(), pdfjsAssets(), guides(), siteFiles()],
    // The app, plus the plain pages: Privacy, Terms, and the page Vercel shows for an unknown address (404.html).
    build: { rollupOptions: { input: { main: "index.html", privacy: "privacy.html", terms: "terms.html", notFound: "404.html" } } },
    // Libraries loaded only on demand (the Excel export), bundled when the dev server starts. Otherwise the dev server
    // finds them mid-session, re-bundles, and pages already open fail with "Failed to fetch dynamically imported module".
    optimizeDeps: { include: ["exceljs"] },
  };
});

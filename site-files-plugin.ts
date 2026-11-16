import type { Plugin } from "vite";

/**
 * The site's own address, for link previews (og:url, og:image), the canonical link and the sitemap. On Vercel it's
 * the production domain (VERCEL_PROJECT_PRODUCTION_URL); SITE_URL overrides it (e.g. https://proposalworkspace.com).
 * Pages write it as %SITE_URL%. Also writes robots.txt and sitemap.xml into the build.
 */
export function siteFiles(): Plugin {
  const site = () =>
    (process.env.SITE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "")).replace(/\/$/, "");
  return {
    name: "site-files",
    transformIndexHtml(html) {
      return html.replaceAll("%SITE_URL%", site());
    },
    configureServer(server) {
      // Vercel serves /privacy from privacy.html (cleanUrls); the dev server does the same.
      server.middlewares.use((req, _res, next) => {
        const path = req.url?.split("?")[0];
        if (path === "/privacy" || path === "/terms") req.url = `${path}.html`;
        next();
      });
      server.middlewares.use("/robots.txt", (_req, res) => {
        res.setHeader("content-type", "text/plain");
        res.end(robots(site()));
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots(site()) });
      if (site()) this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemap(site()) });
    },
  };
}

// The public pages may be indexed; the API never.
const robots = (site: string) => `User-agent: *\nAllow: /\nDisallow: /api/\n${site ? `\nSitemap: ${site}/sitemap.xml\n` : ""}`;

const sitemap = (site: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${site}/</loc></url>
  <url><loc>${site}/privacy</loc></url>
  <url><loc>${site}/terms</loc></url>
</urlset>
`;

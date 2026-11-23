import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { publishedGuides } from "./guide-plugin";

/**
 * The site's own address, for link previews (og:url, og:image), the canonical link and the sitemap. On Vercel it's
 * the production domain (VERCEL_PROJECT_PRODUCTION_URL); SITE_URL overrides it (e.g. https://proposalworkspace.com).
 * Pages write it as %SITE_URL%. Also writes robots.txt and sitemap.xml into the build, and llms.txt and llms-full.txt
 * (site/: what the site is, in Markdown, for AI tools and AI search). With no address yet, their links stay relative.
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
      for (const name of LLM_FILES)
        server.middlewares.use(`/${name}`, (_req, res) => {
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(llmFile(name, site()));
        });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robots(site()) });
      if (site()) this.emitFile({ type: "asset", fileName: "sitemap.xml", source: sitemap(site()) });
      for (const name of LLM_FILES) this.emitFile({ type: "asset", fileName: name, source: llmFile(name, site()) });
    },
  };
}

// The public pages may be indexed; the API never.
const robots = (site: string) => `User-agent: *\nAllow: /\nDisallow: /api/\n${site ? `\nSitemap: ${site}/sitemap.xml\n` : ""}`;

export const sitemap = (site: string, guides = publishedGuides()) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${site}/</loc></url>
  <url><loc>${site}/guide</loc></url>
${guides.map((g) => `  <url><loc>${site}/guide/${g.slug}</loc>${g.updated ? `<lastmod>${g.updated}</lastmod>` : ""}</url>\n`).join("")}  <url><loc>${site}/privacy</loc></url>
  <url><loc>${site}/terms</loc></url>
</urlset>
`;

/** What the site is, for AI tools and AI search (llmstxt.org): a short guide, and the full text in one file. */
const LLM_FILES = ["llms.txt", "llms-full.txt"] as const;
/** One of them, with the site's address in its links (relative links when there's no address yet). */
export const llmFile = (name: (typeof LLM_FILES)[number], site: string, guides = publishedGuides()) =>
  readFileSync(new URL(`./site/${name}`, import.meta.url), "utf8")
    // The published guides, listed where the file says %GUIDES% (nothing until there are some).
    .replace(
      /%GUIDES%\n?/,
      guides.length ? `## Guides\n\n${guides.map((g) => `- [${g.title}](%SITE_URL%/guide/${g.slug}): ${g.description}`).join("\n")}\n` : "",
    )
    .replaceAll("%SITE_URL%", site);

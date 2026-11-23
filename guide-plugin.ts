import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";
import type { Plugin } from "vite";

/**
 * The Guide (/guide): help and how-to articles, as real pages search engines and AI search can read (the app's own
 * pages are behind # addresses, which aren't indexed).
 *
 * Write each guide as Markdown in content/guides/ (copy content/guides/_template.md). Before each build (and when the
 * dev server starts or a guide changes), this turns them into pages under guide/ (generated; not committed), which
 * the build then processes like any other page: the site's styles, fonts and analytics. It also makes the /guide
 * index, and lists published guides in the sitemap and llms.txt (site-files-plugin.ts).
 *
 * A guide marked "draft: true" is only on the dev server, marked Draft; it's never published.
 */

const SOURCE = "content/guides";
const OUT = "guide";

export type Guide = {
  slug: string;
  title: string;
  description: string;
  /** YYYY-MM-DD, shown on the page and in the article's structured data */
  updated: string;
  draft: boolean;
  /** lower first in the index; then by title */
  order: number;
  body: string;
};

/** "---\nkey: value\n---\nbody": the fields a guide declares, and its Markdown. */
export function parseGuide(file: string, text: string): Guide {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: starts without its "---" header (see content/guides/_template.md)`);
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const f = /^([a-z]+):\s*(.*)$/i.exec(line.trim());
    // A value may be wrapped in quotes (title: "Fees: a guide"); quotes that only end it are part of it.
    if (f) fields[f[1].toLowerCase()] = f[2].trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  const slug = (fields.slug || file.replace(/\.md$/, "")).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`${file}: the address "${slug}" may only use a–z, 0–9 and single hyphens`);
  for (const key of ["title", "description"]) if (!fields[key]) throw new Error(`${file}: needs a ${key}`);
  if (fields.updated && !/^\d{4}-\d{2}-\d{2}$/.test(fields.updated)) throw new Error(`${file}: "updated" must be YYYY-MM-DD`);
  return {
    slug,
    title: fields.title,
    description: fields.description,
    updated: fields.updated ?? "",
    draft: fields.draft !== "false",
    order: Number(fields.order ?? 100) || 100,
    body: m[2],
  };
}

/** Every guide in content/guides (files starting with _ are notes and templates, never pages), in index order. */
export function readGuides(dir = SOURCE): Guide[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  } catch {
    return [];
  }
  const guides = files.map((f) => parseGuide(f, readFileSync(join(dir, f), "utf8")));
  const seen = new Set<string>();
  for (const g of guides) {
    if (seen.has(g.slug)) throw new Error(`Two guides share the address /guide/${g.slug}`);
    seen.add(g.slug);
  }
  return guides.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/** The guides that go on the live site. */
export const publishedGuides = (dir = SOURCE) => readGuides(dir).filter((g) => !g.draft);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The page around every guide and the index: the site's header and footer, and its tags for search and previews. */
function page(o: { title: string; description: string; path: string; body: string; jsonLd: object }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(o.title)}</title>
    <meta name="description" content="${esc(o.description)}" />
    <link rel="canonical" href="%SITE_URL%${o.path}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Proposal Workspace" />
    <meta property="og:title" content="${esc(o.title)}" />
    <meta property="og:description" content="${esc(o.description)}" />
    <meta property="og:url" content="%SITE_URL%${o.path}" />
    <meta property="og:image" content="%SITE_URL%/og-image.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <script type="application/ld+json">${JSON.stringify(o.jsonLd).replace(/</g, "\\u003c")}</script>
    <script type="module" src="/src/legal.ts"></script>
  </head>
  <body>
    <header class="legal-bar"><a class="mark" href="/">Proposal Workspace</a><a class="legal-bar-link" href="/guide">Guide</a></header>
    <main class="legal guide">
${o.body}
    </main>
    <footer class="legal-foot">
      <span>© <span data-year>2026</span> Proposal Workspace, LLC</span>
      <a href="/guide">Guide</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </footer>
  </body>
</html>
`;
}

const publisher = { "@type": "Organization", name: "Proposal Workspace, LLC" };

/** One guide's page. */
export function guidePage(g: Guide): string {
  const html = new Marked({ gfm: true }).parse(g.body, { async: false }) as string;
  return page({
    title: `${g.title} · Proposal Workspace Guide`,
    description: g.description,
    path: `/guide/${g.slug}`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: g.title,
      description: g.description,
      ...(g.updated ? { dateModified: g.updated } : {}),
      author: publisher,
      publisher,
      mainEntityOfPage: `%SITE_URL%/guide/${g.slug}`,
    },
    body: `      <nav class="guide-crumbs" aria-label="Breadcrumb"><a href="/guide">Guide</a></nav>
      ${g.draft ? `<p class="guide-draft">Draft: only on the dev server. Set "draft: false" to publish it.</p>` : ""}
      <h1>${esc(g.title)}</h1>
      ${g.updated ? `<p class="legal-meta">Updated ${esc(day(g.updated))}</p>` : ""}
      <div class="guide-body">${html}</div>
      <aside class="guide-cta">
        <p><b>Try it on a sample project.</b> The demo needs no sign-up.</p>
        <a class="legal-btn" href="/">Try the demo</a>
      </aside>`,
  });
}

/** The Guide's index: every guide, or a note that they're on the way. */
export function indexPage(guides: Guide[]): string {
  return page({
    title: "Guide · Proposal Workspace",
    description: "How-to guides for architecture firms: analyzing RFPs, leveling consultant fees, building fees and schedules for proposals.",
    path: "/guide",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "Proposal Workspace Guide",
      hasPart: guides.map((g) => ({ "@type": "Article", headline: g.title, url: `%SITE_URL%/guide/${g.slug}` })),
    },
    body: `      <h1>Guide</h1>
      <p class="legal-meta">How-to guides for proposals: RFPs, consultant fees, fees and schedules.</p>
      ${
        guides.length
          ? `<ul class="guide-list">${guides
              .map(
                (g) =>
                  `<li><a href="/guide/${g.slug}"><b>${esc(g.title)}</b></a>${g.draft ? ' <span class="guide-draft-tag">Draft</span>' : ""}<span>${esc(g.description)}</span></li>`,
              )
              .join("")}</ul>`
          : `<p>Guides are on the way.</p>`
      }`,
  });
}

/** Writes guide/ from content/guides: the index and every guide (drafts too, on the dev server only). */
function generate(withDrafts: boolean): Record<string, string> {
  const guides = readGuides().filter((g) => withDrafts || !g.draft);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "index.html"), indexPage(guides));
  const inputs: Record<string, string> = { guide: join(OUT, "index.html") };
  for (const g of guides) {
    writeFileSync(join(OUT, `${g.slug}.html`), guidePage(g));
    inputs[`guide-${g.slug}`] = join(OUT, `${g.slug}.html`);
  }
  return inputs;
}

export function guides(): Plugin {
  return {
    name: "guides",
    config(_config, { command }) {
      // The pages exist before the build looks for its inputs; drafts only when serving locally.
      const inputs = generate(command === "serve");
      return { build: { rollupOptions: { input: inputs } } };
    },
    configureServer(server) {
      // /guide and /guide/<slug> as on Vercel (cleanUrls).
      server.middlewares.use((req, _res, next) => {
        const path = req.url?.split("?")[0] ?? "";
        if (path === "/guide" || path === "/guide/") req.url = "/guide/index.html";
        else if (/^\/guide\/[a-z0-9-]+$/.test(path)) req.url = `${path}.html`;
        next();
      });
      // Editing a guide rewrites the pages and reloads the browser.
      server.watcher.add(SOURCE);
      server.watcher.on("all", (_event, file) => {
        if (!file.replaceAll("\\", "/").includes(`/${SOURCE}/`)) return;
        try {
          generate(true);
          server.ws.send({ type: "full-reload" });
        } catch (err) {
          server.config.logger.error(`[guides] ${(err as Error).message}`);
        }
      });
    },
  };
}

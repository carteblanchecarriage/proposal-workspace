// The Guide (guide-plugin.ts): Markdown guides become pages, drafts never go live, and published guides are listed for
// search engines (sitemap.xml) and AI tools (llms.txt).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guidePage, indexPage, parseGuide, publishedGuides, readGuides } from "../guide-plugin";
import { llmFile, sitemap } from "../site-files-plugin";

const guide = (fields: string, body = "Body.") => `---\n${fields}\n---\n${body}`;

describe("parseGuide", () => {
  it("reads the header and the Markdown", () => {
    const g = parseGuide("how-to.md", guide("title: How to level fees\ndescription: Short.\nupdated: 2026-11-23\norder: 5\ndraft: false", "## Step one"));
    expect(g).toMatchObject({ slug: "how-to", title: "How to level fees", description: "Short.", updated: "2026-11-23", order: 5, draft: false, body: "## Step one" });
  });

  it("unwraps a quoted value, but keeps quotes that are part of it", () => {
    expect(parseGuide("a.md", guide('title: "Fees: a guide"\ndescription: B')).title).toBe("Fees: a guide");
    expect(parseGuide("a.md", guide('title: Leveling "MEP" fees\ndescription: B')).title).toBe('Leveling "MEP" fees');
    expect(parseGuide("a.md", guide('title: The "Quick" "Guide"\ndescription: B')).title).toBe('The "Quick" "Guide"');
  });

  it("is a draft unless it says draft: false, so nothing publishes by accident", () => {
    expect(parseGuide("a.md", guide("title: A\ndescription: B")).draft).toBe(true);
    expect(parseGuide("a.md", guide("title: A\ndescription: B\ndraft: yes")).draft).toBe(true);
  });

  it("takes its address from slug, else the file name", () => {
    expect(parseGuide("file-name.md", guide("title: A\ndescription: B\nslug: custom-address")).slug).toBe("custom-address");
    expect(parseGuide("File-Name.md", guide("title: A\ndescription: B")).slug).toBe("file-name");
  });

  it.each([
    ["no header", "Just text"],
    ["no title", guide("description: B")],
    ["no description", guide("title: A")],
    ["a bad address", guide("title: A\ndescription: B\nslug: Bad Address!")],
    ["a bad date", guide("title: A\ndescription: B\nupdated: Nov 23")],
  ])("refuses a guide with %s, naming the file", (_, text) => expect(() => parseGuide("x.md", text)).toThrow(/^x\.md: /));
});

describe("readGuides", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "guides-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("skips templates and notes (files starting with _), and sorts by order, then title", () => {
    writeFileSync(join(dir, "_template.md"), guide("title: T\ndescription: T"));
    writeFileSync(join(dir, "b.md"), guide("title: Beta\ndescription: x\ndraft: false"));
    writeFileSync(join(dir, "a.md"), guide("title: Alpha\ndescription: x"));
    writeFileSync(join(dir, "c.md"), guide("title: Gamma\ndescription: x\norder: 1\ndraft: false"));
    expect(readGuides(dir).map((g) => g.title)).toEqual(["Gamma", "Alpha", "Beta"]);
    expect(publishedGuides(dir).map((g) => g.title)).toEqual(["Gamma", "Beta"]);
  });

  it("refuses two guides at the same address", () => {
    writeFileSync(join(dir, "a.md"), guide("title: A\ndescription: x\nslug: same"));
    writeFileSync(join(dir, "b.md"), guide("title: B\ndescription: x\nslug: same"));
    expect(() => readGuides(dir)).toThrow(/\/guide\/same/);
  });

  it("no folder: no guides", () => expect(readGuides(join(dir, "missing"))).toEqual([]));
});

describe("pages", () => {
  const g = parseGuide("level-fees.md", guide('title: Leveling <MEP> "fees"\ndescription: Compare & decide.\nupdated: 2026-11-23\ndraft: false', "## Step one\n\n| a | b |\n|---|---|\n| 1 | 2 |"));
  const html = guidePage(g);

  it("renders the Markdown, tables included", () => {
    expect(html).toContain("<h2>Step one</h2>");
    expect(html).toContain("<table>");
  });

  it("escapes the title and description everywhere they appear", () => {
    expect(html).not.toContain("<MEP>");
    expect(html).toContain("Leveling &lt;MEP&gt; &quot;fees&quot;");
    expect(html).toContain('content="Compare &amp; decide."');
  });

  it("carries what search engines read: title, description, canonical address and article data", () => {
    expect(html).toContain('<link rel="canonical" href="%SITE_URL%/guide/level-fees" />');
    expect(html).toContain('"@type":"Article"');
    expect(html).toContain('"dateModified":"2026-11-23"');
    expect(html).toContain("Updated November 23, 2026");
  });

  it("marks a draft as a draft", () => expect(guidePage({ ...g, draft: true })).toContain("guide-draft"));

  it("the index lists guides, or says they're on the way", () => {
    expect(indexPage([g])).toContain('href="/guide/level-fees"');
    expect(indexPage([])).toContain("Guides are on the way.");
  });
});

describe("search and AI listings", () => {
  const g = parseGuide("level-fees.md", guide("title: Leveling fees\ndescription: Compare.\nupdated: 2026-11-23\ndraft: false"));

  it("the sitemap lists the Guide and each published guide", () => {
    const xml = sitemap("https://example.com", [g]);
    expect(xml).toContain("<loc>https://example.com/guide</loc>");
    expect(xml).toContain("<loc>https://example.com/guide/level-fees</loc><lastmod>2026-11-23</lastmod>");
  });

  it("llms.txt lists published guides with full links, and nothing until there are some", () => {
    expect(llmFile("llms.txt", "https://example.com", [g])).toContain("## Guides\n\n- [Leveling fees](https://example.com/guide/level-fees): Compare.");
    const none = llmFile("llms.txt", "", []);
    expect(none).not.toContain("## Guides");
    expect(none).not.toContain("%GUIDES%");
    expect(none).not.toContain("%SITE_URL%");
  });
});

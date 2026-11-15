// Copies every table and the stored RFP PDFs from one Supabase project to another.
// Run supabase/schema.sql in the NEW project first, then:
//   node --env-file=.env.migrate scripts/migrate-supabase.mjs
// .env.migrate needs OLD_SUPABASE_URL, OLD_SUPABASE_SECRET_KEY, NEW_SUPABASE_URL, NEW_SUPABASE_SECRET_KEY.
// Safe to re-run: rows are upserted by primary key and files are overwritten.

const TABLES = [
  ["rfp_reviews", "id"], ["comparisons", "id"], ["readings", "hash"], ["feedback", "id"], ["projects", "id"],
  ["consultants", "id"], ["schedules", "id"], ["fees", "id"], ["settings", "id"], ["pursuits", "id"],
];
const BUCKET = "pdf-uploads";
const PAGE = 500;

function project(prefix) {
  const url = process.env[`${prefix}_SUPABASE_URL`]?.replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");
  const key = process.env[`${prefix}_SUPABASE_SECRET_KEY`];
  if (!url || !key) throw new Error(`Set ${prefix}_SUPABASE_URL and ${prefix}_SUPABASE_SECRET_KEY in .env.migrate`);
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  return {
    url,
    async fetch(path, init = {}) {
      const res = await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
      if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url}${path.split("?")[0]} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return res;
    },
  };
}

const src = project("OLD");
const dst = project("NEW");
if (src.url === dst.url) throw new Error("OLD and NEW point at the same project.");
console.log(`From ${src.url}\nTo   ${dst.url}\n`);

for (const [table, key] of TABLES) {
  let copied = 0;
  for (let offset = 0; ; offset += PAGE) {
    let rows;
    try {
      rows = await (await src.fetch(`/rest/v1/${table}?select=*&order=${key}.asc&limit=${PAGE}&offset=${offset}`)).json();
    } catch (e) {
      if (offset === 0 && /does not exist|schema cache|404/.test(e.message)) { console.log(`${table}: not in old project, skipped`); break; }
      throw e;
    }
    if (!rows.length) break;
    await dst.fetch(`/rest/v1/${table}?on_conflict=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    copied += rows.length;
    if (rows.length < PAGE) break;
  }
  console.log(`${table}: ${copied} rows`);
}

// Storage: only the RFP PDFs under rfp/ are kept long-term; top-level files are temporary uploads.
async function listFiles(p, prefix) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await p.fetch(`/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000, offset }),
    }).catch((e) => (/not found|404|400/i.test(e.message) ? null : Promise.reject(e)));
    if (!res) return out;
    const items = await res.json();
    out.push(...items.filter((i) => i.id).map((i) => `${prefix}${i.name}`));
    if (items.length < 1000) return out;
  }
}

const files = await listFiles(src, "rfp/");
if (files.length) {
  await dst.fetch("/storage/v1/bucket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 50 * 1024 * 1024, allowed_mime_types: ["application/pdf"] }),
  }).catch((e) => { if (!/already exists|409|Duplicate/i.test(e.message)) throw e; });
  for (const path of files) {
    const body = await (await src.fetch(`/storage/v1/object/${BUCKET}/${path}`)).arrayBuffer();
    await dst.fetch(`/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/pdf", "x-upsert": "true" },
      body,
    });
  }
}
console.log(`storage ${BUCKET}/rfp: ${files.length} files`);
console.log("\nDone.");

// Encrypts the records saved before encryption, and empties the older readable side columns (name, title, …).
// Uses the same code as the app (lib/crypt.ts), so it needs the same DATA_ENCRYPTION_KEY as the deployed site.
//   node --env-file=.env.local scripts/encrypt-data.mjs --dry-run   (counts only)
//   node --env-file=.env.local scripts/encrypt-data.mjs
// Safe to re-run: already-encrypted records are skipped, and a record saved by the app while this runs is left alone.
import { createServer } from "vite";

const dryRun = process.argv.includes("--dry-run");
const url = process.env.SUPABASE_URL?.replace(/\/rest\/v1\/?$/, "").replace(/\/$/, "");
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SECRET_KEY (node --env-file=.env.local …).");
if (!process.env.DATA_ENCRYPTION_KEY) throw new Error("Set DATA_ENCRYPTION_KEY: the same key the deployed site uses.");
const headers = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };

// Readable side columns left over from before encryption, per table.
const TABLES = {
  rfp_reviews: { key: "id", side: ["project"] },
  comparisons: { key: "id", side: ["project"] },
  readings: { key: "hash", side: [] },
  projects: { key: "id", side: ["name"] },
  consultants: { key: "id", side: ["name"] },
  schedules: { key: "id", side: ["title", "project_id"] },
  fees: { key: "id", side: ["title", "project_id"] },
  settings: { key: "id", side: [] },
  pursuits: { key: "id", side: ["rfp_id", "outcome"] },
};

const vite = await createServer({ server: { middlewareMode: true }, logLevel: "error", appType: "custom" });
const { seal, unseal, isSealed, rowAad } = await vite.ssrLoadModule("/lib/crypt.ts");
const q = encodeURIComponent;

async function rest(path, init = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path.split("?")[0]} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

let failed = false;
try {
  for (const [table, { key: k, side }] of Object.entries(TABLES)) {
    let encrypted = 0, already = 0, skipped = 0, sideCleared = 0;
    for (let offset = 0; ; offset += 500) {
      const rows = await rest(`${table}?select=org_id,${k},saved_at,data${side.length ? "," + side.join(",") : ""}&order=org_id.asc,${k}.asc&limit=500&offset=${offset}`);
      for (const r of rows) {
        const aad = rowAad(table, String(r[k]));
        const hasSide = side.some((c) => r[c] != null);
        if (isSealed(r.data)) {
          already++;
          if (hasSide && !dryRun) {
            await rest(`${table}?org_id=eq.${q(r.org_id)}&${k}=eq.${q(r[k])}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(Object.fromEntries(side.map((c) => [c, null]))) });
            sideCleared++;
          }
          continue;
        }
        if (dryRun) { encrypted++; continue; }
        const body = { data: seal(r.org_id, aad, r.data), ...Object.fromEntries(side.map((c) => [c, null])) };
        // Only if it hasn't been saved since it was read (saved_at unchanged).
        const updated = await rest(`${table}?org_id=eq.${q(r.org_id)}&${k}=eq.${q(r[k])}&saved_at=eq.${q(r.saved_at)}`, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(body),
        });
        if (updated.length) {
          // Check it reads back to exactly the same record.
          const back = unseal(r.org_id, aad, updated[0].data);
          if (JSON.stringify(back) !== JSON.stringify(r.data)) throw new Error(`${table} ${r[k]}: read-back mismatch`);
          encrypted++;
        } else skipped++;
      }
      if (rows.length < 500) break;
    }
    console.log(`${table.padEnd(12)} ${dryRun ? "to encrypt" : "encrypted"}: ${encrypted}, already encrypted: ${already}${skipped ? `, skipped (saved meanwhile, already encrypted by the app): ${skipped}` : ""}${sideCleared ? `, side columns emptied: ${sideCleared}` : ""}`);
  }
} catch (err) {
  failed = true;
  console.error("Stopped:", err.message);
} finally {
  await vite.close();
}
if (failed) process.exit(1);
console.log(dryRun ? "\nDry run: nothing changed." : "\nDone.");

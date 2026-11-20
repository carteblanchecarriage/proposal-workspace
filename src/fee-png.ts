// "Save as PNG" for the fee's Proposal table, for InDesign and other layout tools. The table on the page is drawn
// onto a canvas at print resolution, cell by cell and word by word from its own layout (backgrounds, borders, fonts,
// colors), so the image matches what's on screen. The PNG is marked 300 dpi, so InDesign places it at its real size.
// Drawn directly rather than through an SVG snapshot of the page, which some browsers refuse to save.

const DPI = 300;
const SCALE = DPI / 96;

/** Draws the table element as a 300 dpi PNG. */
export async function tablePng(table: HTMLTableElement): Promise<Blob> {
  await document.fonts?.ready;
  const box = table.getBoundingClientRect();
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(box.width * SCALE);
  canvas.height = Math.ceil(box.height * SCALE);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't draw the image.");
  ctx.scale(SCALE, SCALE);
  ctx.translate(-box.left, -box.top);

  // Cells: background, then a 1px border on every side (the table collapses its borders, so neighbours share one).
  const cells = [...table.querySelectorAll<HTMLTableCellElement>("th, td")];
  for (const cell of cells) {
    const r = cell.getBoundingClientRect();
    const cs = getComputedStyle(cell);
    if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") {
      ctx.fillStyle = cs.backgroundColor;
      ctx.fillRect(r.left, r.top, r.width, r.height);
    }
  }
  for (const cell of cells) {
    const r = cell.getBoundingClientRect();
    const cs = getComputedStyle(cell);
    const w = parseFloat(cs.borderTopWidth) || 0;
    if (!w || cs.borderTopStyle === "none") continue;
    ctx.strokeStyle = cs.borderTopColor;
    ctx.lineWidth = w;
    ctx.strokeRect(r.left, r.top, r.width, r.height);
  }

  // Text: every word where the page put it, in its element's font and color.
  const walker = document.createTreeWalker(table, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const el = node.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    ctx.fillStyle = cs.color;
    ctx.textBaseline = "alphabetic";
    if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
    const upper = cs.textTransform === "uppercase";
    const text = node.data;
    for (const m of text.matchAll(/\S+/g)) {
      range.setStart(node, m.index!);
      range.setEnd(node, m.index! + m[0].length);
      const r = range.getClientRects()[0];
      if (!r) continue;
      const word = upper ? m[0].toUpperCase() : m[0];
      const metrics = ctx.measureText(word);
      const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
      const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
      ctx.fillText(word, r.left, r.top + (r.height - (ascent + descent)) / 2 + ascent);
    }
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The image couldn't be made.");
  return withDpi(blob, DPI);
}

// ---------- PNG resolution (a pHYs chunk), so layout apps size it right ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Adds (or replaces) the PNG's pHYs chunk with the given dots per inch. */
export async function withDpi(png: Blob, dpi: number): Promise<Blob> {
  const src = new Uint8Array(await png.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9); // data length
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, ppm);
  view.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  // Rebuild: the signature, IHDR, our pHYs, then every other chunk except an existing pHYs.
  const out: Uint8Array[] = [src.subarray(0, 8)];
  let i = 8;
  let placed = false;
  while (i < src.length) {
    const len = new DataView(src.buffer, src.byteOffset + i).getUint32(0);
    const type = String.fromCharCode(...src.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (type !== "pHYs") out.push(src.subarray(i, end));
    if (type === "IHDR" && !placed) {
      out.push(chunk);
      placed = true;
    }
    i = end;
  }
  return new Blob(out as BlobPart[], { type: "image/png" });
}

/** Saves a file with the given name. */
export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

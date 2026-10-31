// Rebuttal - evidence documents to images.
//
// Airwallex's File Service takes evidence as JPG/PNG/WEBP up to 10MB, so each
// document gather() built (title + lines taken from the merchant's records) is
// drawn as a plain A4-shaped page: a header naming the dispute and the source,
// the lines word-wrapped, and a footer saying where every line came from. The
// page shows only what the record holds - nothing is restyled into a claim.
//
// toSvg() has no dependencies; toPng() uses @resvg/resvg-js (prebuilt, no
// browser). Long documents split into pages so text never shrinks to fit.

export const PAGE = { width: 1240, height: 1754, margin: 90, font: 26, lineHeight: 38 };
export const MAX_BYTES = 10 * 1024 * 1024;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Monospace-free wrapping: an average glyph is ~0.5em in a sans face, which
// keeps a line inside the margin for ordinary text; a word longer than a line
// (a URL, a tracking number) is hard-split rather than run off the page.
export function wrap(text, maxChars) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > maxChars) {
        if (line) { out.push(line); line = ''; }
        out.push(word.slice(0, maxChars));
        word = word.slice(maxChars);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

// paginate(doc, meta) -> [[line, ...], ...]; one array per page of body text.
export function paginate(doc, page = PAGE) {
  const maxChars = Math.floor((page.width - 2 * page.margin) / (page.font * 0.5));
  const body = doc.lines.filter((l) => l !== '').flatMap((l) => [...wrap(l, maxChars), '']);
  const perPage = Math.floor((page.height - 2 * page.margin - 260) / page.lineHeight);
  const pages = [];
  for (let i = 0; i < body.length; i += perPage) pages.push(body.slice(i, i + perPage));
  return pages.length ? pages : [[]];
}

// toSvg(doc, meta, pageNo) - meta: { disputeId, merchant, generatedAt }.
export function toSvg(doc, meta, pageNo = 0, page = PAGE) {
  const pages = paginate(doc, page);
  const lines = pages[pageNo] || [];
  const { width: w, height: h, margin: m, font, lineHeight } = page;
  const y0 = m + 230;
  const text = lines.map((l, i) => `<text x="${m}" y="${y0 + i * lineHeight}">${esc(l)}</text>`).join('\n');
  const of = pages.length > 1 ? ` - page ${pageNo + 1} of ${pages.length}` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="#ffffff"/>
<g font-family="Arial, Helvetica, sans-serif" fill="#111111">
<text x="${m}" y="${m + 20}" font-size="22" fill="#555555">${esc(meta.merchant || 'Merchant')} - evidence for dispute ${esc(meta.disputeId)}</text>
<text x="${m}" y="${m + 90}" font-size="40" font-weight="bold">${esc(doc.title)}</text>
<text x="${m}" y="${m + 140}" font-size="22" fill="#555555">Field: ${esc(doc.field)}${of}</text>
<line x1="${m}" y1="${m + 170}" x2="${w - m}" y2="${m + 170}" stroke="#cccccc" stroke-width="2"/>
<g font-size="${font}">
${text}
</g>
<line x1="${m}" y1="${h - m - 40}" x2="${w - m}" y2="${h - m - 40}" stroke="#cccccc" stroke-width="2"/>
<text x="${m}" y="${h - m}" font-size="20" fill="#555555">Copied from the merchant's own records (orders, carrier scans, emails, logins, policy). Prepared ${esc(meta.generatedAt || '')}.</text>
</g>
</svg>`;
}

let Resvg = null;
async function resvg() {
  if (!Resvg) ({ Resvg } = await import('@resvg/resvg-js'));
  return Resvg;
}

// toPng(doc, meta) -> [{ name, bytes, page }] - one PNG per page, each checked
// against the File Service limit.
export async function toPng(doc, meta, page = PAGE) {
  const R = await resvg();
  const n = paginate(doc, page).length;
  const out = [];
  for (let p = 0; p < n; p++) {
    const svg = toSvg(doc, meta, p, page);
    const bytes = new R(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }).render().asPng();
    if (bytes.length > MAX_BYTES) throw new Error(`${doc.id} page ${p + 1} is ${bytes.length} bytes, over the 10MB limit`);
    out.push({ name: `${doc.id}${n > 1 ? `_p${p + 1}` : ''}.png`, bytes, page: p + 1 });
  }
  return out;
}

// toPdf(doc, meta) -> [{ name, bytes, page }] - the same page as toSvg, laid out
// as text in one multi-page PDF. The challenge endpoint refuses PNG evidence
// ("File type png is not supported", measured 2026-10-31) although the File
// Service stores it, so submissions send this; the PNGs stay for the board.
// No dependencies: base-14 Helvetica, WinAnsi, anything outside Latin-1 -> '?'.
export function toPdf(doc, meta, page = PAGE) {
  const k = 595.28 / page.width; // A4 points per page pixel
  const H = page.height * k;
  const pdfText = (s) => String(s).replace(/[^\x20-\xff]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);
  const t = (x, y, size, s, { bold = false, grey = false } = {}) =>
    `${grey ? '0.33 g' : '0.07 g'} BT /${bold ? 'F2' : 'F1'} ${(size * k).toFixed(2)} Tf ${(x * k).toFixed(2)} ${(H - y * k).toFixed(2)} Td (${pdfText(s)}) Tj ET`;
  const ln = (y) => `0.8 G 1 w ${(page.margin * k).toFixed(2)} ${(H - y * k).toFixed(2)} m ${((page.width - page.margin) * k).toFixed(2)} ${(H - y * k).toFixed(2)} l S`;
  const pages = paginate(doc, page);
  const { margin: m, font, lineHeight } = page;
  const streams = pages.map((lines, p) => {
    const of = pages.length > 1 ? ` - page ${p + 1} of ${pages.length}` : '';
    return [
      t(m, m + 20, 22, `${meta.merchant || 'Merchant'} - evidence for dispute ${meta.disputeId}`, { grey: true }),
      t(m, m + 90, 40, doc.title, { bold: true }),
      t(m, m + 140, 22, `Field: ${doc.field}${of}`, { grey: true }),
      ln(m + 170),
      ...lines.map((l, i) => t(m, m + 230 + i * lineHeight, font, l)),
      ln(page.height - m - 40),
      t(m, page.height - m, 20, `Copied from the merchant's own records (orders, carrier scans, emails, logins, policy). Prepared ${meta.generatedAt || ''}.`, { grey: true }),
    ].join('\n');
  });
  // objects: 1 catalog, 2 pages, 3 F1, 4 F2, then page/content pairs
  const objs = [];
  const kids = streams.map((_, i) => `${5 + 2 * i} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${streams.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  for (const [i, s] of streams.entries()) {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 ${H.toFixed(2)}] `
      + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`);
    objs.push(`<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(Buffer.from(out, 'latin1'));
  if (bytes.length > MAX_BYTES) throw new Error(`${doc.id} is ${bytes.length} bytes, over the 10MB limit`);
  return [{ name: `${doc.id}.pdf`, bytes, page: pages.length }];
}

// The documents a challenge actually attaches: those whose ids the packed
// evidence names. Uploading the rest would hand a reviewer noise.
export function attached(documents, packed) {
  const ids = new Set(Object.values(packed).filter(Array.isArray).flat());
  return documents.filter((d) => ids.has(d.id));
}

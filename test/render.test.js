import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wrap, paginate, toSvg, toPng, attached, PAGE, MAX_BYTES } from '../src/render.js';
import { processAll } from '../src/run.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const doc = { id: 'doc_x_order_snapshot', field: 'order_snapshot_file_ids', title: 'Order <KK-1> & co', lines: ['a "quoted" line'] };
const meta = { disputeId: 'pd_x', merchant: 'Kettle & Kiln', generatedAt: '2026-10-25' };

test('wrap keeps every line inside the width and hard-splits a long token', () => {
  const lines = wrap(`short words here ${'x'.repeat(130)} tail`, 50);
  assert.ok(lines.every((l) => l.length <= 50));
  assert.equal(lines.join('').replace(/\s/g, ''), `shortwordshere${'x'.repeat(130)}tail`);
});

test('svg escapes record text instead of breaking the markup', () => {
  const svg = toSvg(doc, meta);
  assert.match(svg, /Order &lt;KK-1&gt; &amp; co/);
  assert.match(svg, /a &quot;quoted&quot; line/);
  assert.match(svg, /Kettle &amp; Kiln - evidence for dispute pd_x/);
  assert.doesNotMatch(svg, /<KK-1>/);
});

test('a long document splits into pages instead of shrinking the text', () => {
  const long = { ...doc, lines: Array.from({ length: 80 }, (_, i) => `login event ${i} from 203.0.113.7`) };
  const pages = paginate(long);
  assert.ok(pages.length >= 2);
  assert.equal(pages.flat().filter(Boolean).length, 80);
  assert.match(toSvg(long, meta, 1), /page 2 of/);
});

test('png output is a real PNG under the File Service limit, one per page', async () => {
  const [png] = await toPng(doc, meta);
  assert.equal(png.name, 'doc_x_order_snapshot.png');
  assert.deepEqual([...png.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(png.bytes.length < MAX_BYTES);
  assert.equal(png.bytes.readUInt32BE(16), PAGE.width);
});

test('only documents named in the packed challenge are attached', () => {
  const results = processAll(load('disputes.json'), load('store.json'), { now: new Date('2026-10-25T00:00:00Z') });
  for (const r of results.filter((x) => x.body?.challenge_details)) {
    const packed = r.body.challenge_details.evidence;
    const docs = attached(r.gathered.documents, packed);
    const named = Object.values(packed).filter(Array.isArray).flat();
    assert.deepEqual(docs.map((d) => d.id).sort(), [...new Set(named)].sort());
    assert.ok(docs.length <= r.gathered.documents.length);
  }
});

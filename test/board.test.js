import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardHtml, order, totals } from '../src/board.js';
import { processAll } from '../src/run.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const now = new Date('2026-10-25T00:00:00Z');
const results = processAll(load('disputes.json'), load('store.json'), { now });

test('cases that need the merchant come first, then by deadline', () => {
  const sorted = order(results);
  const firstNonUrgent = sorted.find((r) => !r.decision.urgent);
  const urgentAfter = sorted.slice(sorted.indexOf(firstNonUrgent)).some((r) => r.decision.urgent);
  assert.equal(urgentAfter, false);
  const plain = sorted.filter((r) => !r.decision.urgent).map((r) => r.decision.action);
  const rank = { ESCALATE: 0, CHALLENGE: 1, ACCEPT: 2, NONE: 3 };
  assert.deepEqual(plain, [...plain].sort((a, b) => rank[a] - rank[b]));
});

test('totals count every case once and the tiles match the decisions', () => {
  const t = totals(results);
  assert.equal(Object.values(t.byAction).reduce((a, b) => a + b, 0), results.length);
  const html = boardHtml(results, { merchant: 'Kettle & Kiln', generatedAt: '2026-10-25' });
  assert.equal((html.match(/<article /g) || []).length, results.length);
  assert.match(html, /Kettle &amp; Kiln/);
  assert.match(html, /nothing is sent/);
});

test('record text is escaped and evidence pages link by document id', () => {
  const r = structuredClone(results.find((x) => x.decision.action === 'CHALLENGE'));
  r.decision.why = '<script>alert(1)</script>';
  const docId = Object.values(r.body.challenge_details.evidence).find(Array.isArray)[0];
  const html = boardHtml([r], { images: { [docId]: [`evidence/${docId}.png`] } });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, new RegExp(`href="evidence/${docId}.png"`));
});

test('an escalated case shows what is missing and no request body', () => {
  const esc = results.filter((x) => x.decision.action === 'ESCALATE');
  assert.ok(esc.length);
  const html = boardHtml(esc);
  assert.match(html, /Needs you/);
  assert.doesNotMatch(html, /Request body/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gather, packFor } from '../src/evidence.js';
import { processAll } from '../src/run.js';
import { EVIDENCE_FIELDS, FILE_FIELDS } from '../src/rules.js';

const load = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'));
const store = load('store.json');
const disputes = load('disputes.json');
const NOW = new Date('2026-10-25T00:00:00Z');
const byId = Object.fromEntries(processAll(disputes, store, { now: NOW }).map((r) => [r.dispute.id, r]));

test('every fixture dispute lands on the action a careful merchant would take', () => {
  const want = {
    pd_demo_01: ['CHALLENGE', 'PRODUCT_RECEIVED'], pd_demo_02: ['CHALLENGE', 'PURCHASE_HISTORY'],
    pd_demo_03: ['ESCALATE'], pd_demo_04: ['CHALLENGE', 'NOT_ENTITLED'],
    pd_demo_05: ['ACCEPT', 'LOW_VALUE_TRANSACTION'], pd_demo_06: ['CHALLENGE', 'SEPARATE_PRODUCT'],
    pd_demo_07: ['ESCALATE'], pd_demo_08: ['ACCEPT', 'VALID_CUSTOMER_DISPUTE'],
    pd_demo_09: ['CHALLENGE', 'CUSTOMER_REFUNDED'], pd_demo_10: ['NONE'],
  };
  for (const [id, [action, reason]] of Object.entries(want)) {
    assert.equal(byId[id].decision.action, action, id);
    if (reason) assert.equal(byId[id].decision.reason, reason, id);
  }
});

test('a parcel with no delivery scan is not proof of delivery', () => {
  const g = byId.pd_demo_08.gathered;
  assert.equal(g.evidence.order_fulfillment_file_ids, undefined);
  assert.equal(g.evidence.order_fulfilled_at, undefined);
  assert.ok(g.notes.some((n) => n.includes('no delivery scan')));
});

test('guest checkout yields no account activity and no purchase history', () => {
  const g = byId.pd_demo_03.gathered;
  assert.equal(g.evidence.access_activity_file_ids, undefined);
  assert.equal(g.evidence.previous_purchase_similar_product_file_ids, undefined);
});

test('history skips orders still under dispute but counts disputes the merchant won', () => {
  const g = byId.pd_demo_02.gathered; // Ben: KK-0951 is disputed (pd_07), KK-1003 was WON (pd_10)
  const hist = g.documents.find((d) => d.field === 'previous_purchase_similar_product_file_ids');
  assert.deepEqual(hist.lines.map((l) => l.split(' ')[0]), ['KK-0877', 'KK-1003']);
  assert.ok(g.evidence.previous_dispute_won_on_same_card_file_ids);
});

test('a same-amount order with the same items is a real duplicate, not explained away', () => {
  const s = structuredClone(store);
  s.orders.find((o) => o.id === 'KK-1064').items = ['SKU-CUP', 'SKU-SAM'];
  const g = gather(disputes.find((d) => d.id === 'pd_demo_06'), s, disputes);
  assert.equal(g.evidence.duplicate_explanation, undefined);
  assert.ok(g.notes.some((n) => n.includes('real duplicate')));
});

test('no matching order gathers nothing', () => {
  const g = gather({ id: 'pd_x', payment_intent_id: 'int_none', reason: { type: 'FRAUDULENT' } }, store, []);
  assert.equal(g.order, null);
  assert.deepEqual(g.evidence, {});
});

test('every evidence key is an Airwallex field and every file field points at a document', () => {
  for (const r of Object.values(byId)) {
    const ids = new Set(r.gathered.documents.map((d) => d.id));
    for (const [k, v] of Object.entries(r.gathered.evidence)) {
      assert.ok(EVIDENCE_FIELDS.includes(k), k);
      if (FILE_FIELDS.includes(k)) for (const id of v) assert.ok(ids.has(id), `${r.dispute.id} ${id}`);
    }
  }
});

test('the challenge pack carries only what the decision relies on', () => {
  const r = byId.pd_demo_01;
  const sent = Object.keys(r.body.challenge_details.evidence).sort();
  const allowed = new Set([...r.decision.fields, 'merchant_business_model_description']);
  for (const k of sent) assert.ok(allowed.has(k), k);
  assert.ok(sent.includes('order_fulfillment_file_ids'));
  assert.deepEqual(packFor({ fields: [] }, { product_description: 'x' }), {});
});

test('the trail explains every case and nothing is sent for real', () => {
  for (const r of Object.values(byId)) {
    assert.equal(r.trail[0].step, 'fetch');
    assert.ok(r.trail.some((e) => e.step === 'decide'));
    for (const e of r.trail.filter((x) => x.step === 'submit')) assert.match(e.detail, /^dry run/);
  }
  assert.equal(byId.pd_demo_10.decision.urgent, false, 'a closed case is never urgent');
  assert.equal(byId.pd_demo_02.decision.urgent, true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REASON_RULES, REASON_TYPES, CHALLENGE_REASONS, EVIDENCE_FIELDS, ACCEPT_REASONS,
  decide, missingEvidence, challengeBody, acceptBody,
} from '../src/rules.js';

const NOW = new Date('2026-10-25T00:00:00Z');
const dispute = (over = {}) => ({
  id: 'pd_1', status: 'REQUIRES_RESPONSE', stage: 'CHARGEBACK', amount: 120, currency: 'USD',
  due_at: '2026-11-01T00:00:00+0000', reason: { type: 'PRODUCT_NOT_RECEIVED', original_code: '13.1' },
  refunds: [], ...over,
});
const DELIVERED = { order_fulfillment_file_ids: ['file_pod'], order_fulfilled_at: '2026-10-02' };

test('every rule uses only Airwallex enums and field names', () => {
  for (const [type, rule] of Object.entries(REASON_RULES)) {
    assert.ok(REASON_TYPES.includes(type), type);
    for (const r of rule.reasons) assert.ok(CHALLENGE_REASONS.includes(r), `${type} ${r}`);
    for (const f of [...rule.required.flat(), ...rule.supporting]) assert.ok(EVIDENCE_FIELDS.includes(f), `${type} ${f}`);
  }
});

test('not-received with proof of delivery is challenged as PRODUCT_RECEIVED', () => {
  const d = decide(dispute(), DELIVERED, {}, NOW);
  assert.equal(d.action, 'CHALLENGE');
  assert.equal(d.reason, 'PRODUCT_RECEIVED');
  assert.deepEqual(d.fields.sort(), ['order_fulfilled_at', 'order_fulfillment_file_ids']);
});

test('never challenges without the required evidence', () => {
  const big = decide(dispute({ amount: 400 }), { order_fulfilled_at: '2026-10-02' }, {}, NOW);
  assert.equal(big.action, 'ESCALATE');
  assert.deepEqual(big.missing, ['order_fulfillment_file_ids']);
  const small = decide(dispute({ amount: 30 }), {}, {}, NOW);
  assert.equal(small.action, 'ACCEPT');
  assert.equal(small.reason, 'VALID_CUSTOMER_DISPUTE');
});

test('never accepts above the merchant limit without a human', () => {
  for (const amount of [51, 500]) {
    assert.notEqual(decide(dispute({ amount }), {}, { autoAcceptMax: 50 }, NOW).action, 'ACCEPT');
  }
});

test('any-of requirements: fraud needs one history proof plus the order', () => {
  const fraud = dispute({ reason: { type: 'FRAUDULENT' } });
  assert.equal(missingEvidence('FRAUDULENT', { order_snapshot_file_ids: ['f'] }).length, 1);
  const d = decide(fraud, { order_snapshot_file_ids: ['f'], access_activity_file_ids: ['ip'] }, {}, NOW);
  assert.equal(d.action, 'CHALLENGE');
  assert.equal(d.reason, 'PURCHASE_HISTORY');
});

test('low-value cases with full evidence are accepted, not fought', () => {
  const d = decide(dispute({ amount: 9 }), DELIVERED, {}, NOW);
  assert.equal(d.action, 'ACCEPT');
  assert.equal(d.reason, 'LOW_VALUE_TRANSACTION');
});

test('already refunded in full is challenged as CUSTOMER_REFUNDED', () => {
  const d = decide(dispute({ refunds: [{ amount: 120 }] }), {}, {}, NOW);
  assert.equal(d.action, 'CHALLENGE');
  assert.equal(d.reason, 'CUSTOMER_REFUNDED');
});

test('closed, late and unchallengeable cases', () => {
  assert.equal(decide(dispute({ status: 'WON' }), DELIVERED, {}, NOW).action, 'NONE');
  assert.equal(decide(dispute({ due_at: '2026-10-24T00:00:00+0000' }), DELIVERED, {}, NOW).action, 'NONE');
  assert.equal(decide(dispute({ stage: 'PRE_ARBITRATION' }), DELIVERED, {}, NOW).action, 'ESCALATE');
  assert.equal(decide(dispute({ reason: { type: 'BANK_REJECTION' } }), DELIVERED, {}, NOW).action, 'ESCALATE');
});

test('urgent flag inside 48h of due_at', () => {
  assert.equal(decide(dispute({ due_at: '2026-10-26T00:00:00+0000' }), DELIVERED, {}, NOW).urgent, true);
  assert.equal(decide(dispute(), DELIVERED, {}, NOW).urgent, false);
});

test('challenge body carries only valid evidence and the stage', () => {
  const d = dispute();
  const dec = decide(d, { ...DELIVERED, product_description: '' }, {}, NOW);
  const body = challengeBody(d, dec, { ...DELIVERED, product_description: '' }, 'req-1', 'PHYSICAL_GOODS');
  assert.deepEqual(body.challenge_details, { reason: 'PRODUCT_RECEIVED', stage: 'CHARGEBACK',
    product_type: 'PHYSICAL_GOODS', evidence: DELIVERED });
  assert.throws(() => challengeBody(d, dec, DELIVERED, 'req-1'), /product_type is required/);
  assert.throws(() => challengeBody(d, dec, DELIVERED, 'req-1', 'TEA'), /bad product_type/);
  assert.throws(() => challengeBody(d, dec, { tracking_photo: ['x'] }, 'req-1', 'PHYSICAL_GOODS'), /unknown evidence field/);
  assert.throws(() => challengeBody(d, dec, { order_fulfillment_file_ids: 'x' }, 'req-1', 'PHYSICAL_GOODS'), /array of file ids/);
  assert.throws(() => challengeBody(d, dec, DELIVERED, '', 'PHYSICAL_GOODS'), /request_id/);
});

test('accept body: valid reason, explicit refund at RFI only', () => {
  const rfi = dispute({ stage: 'RFI', amount: 30, refunds: [{ amount: 10 }] });
  const dec = decide(rfi, {}, {}, NOW);
  const body = acceptBody(rfi, dec, 'req-2');
  assert.ok(ACCEPT_REASONS.includes(body.reason));
  assert.deepEqual(body.refund, { amount: 20, reason: 'REQUESTED_BY_CUSTOMER' });
  const cb = dispute({ amount: 30 });
  assert.equal(acceptBody(cb, decide(cb, {}, {}, NOW), 'req-3').refund, undefined);
});

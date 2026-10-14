import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { processAll } from '../src/run.js';
import { facts, check, templateLetter, writeLetter, addLetters, completerFromEnv } from '../src/letter.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const now = new Date('2026-10-25T00:00:00Z');
const fresh = () => processAll(load('disputes.json'), load('store.json'), { now });
const byId = (rs, id) => rs.find((r) => r.dispute.id === id);
const merchant = load('store.json').store.name;

test('the template letter passes its own check for every challenge', () => {
  for (const r of fresh().filter((r) => r.body?.challenge_details)) {
    const f = facts(r, merchant);
    const c = check(templateLetter(f, r), f);
    assert.ok(c.ok, `${r.dispute.id}: ${JSON.stringify(c)}`);
  }
});

test('an invented tracking number or amount is caught', () => {
  const r = byId(fresh(), 'pd_demo_01');
  const f = facts(r, merchant);
  assert.deepEqual(check('Order KK-1041 for 86.00 USD was delivered.', f), { ok: true, unsupported: [], claims: [] });
  assert.deepEqual(check('Tracking 1Z555XX0000000001 shows it.', f).unsupported, ['1Z555XX0000000001']);
  assert.deepEqual(check('The customer paid $92.50.', f).unsupported, ['$92.50']);
  assert.ok(check('Paid $86 on 2026-09-20.', f).ok, 'reformatted amount and a timestamp\'s date are the same fact');
});

test('a delivery or sign-in claim needs a document behind it', () => {
  const r = byId(fresh(), 'pd_demo_04');
  const f = facts(r, merchant);
  assert.equal(f.fields.includes('order_fulfillment_file_ids'), false);
  assert.deepEqual(check('The parcel was delivered to the customer.', f).claims, ['delivered']);
  assert.deepEqual(check('The customer logged in from the same phone.', f).claims, ['logged in']);
  assert.ok(check('Returns are accepted within 30 days of delivery.', f).ok, 'quoting the policy is not a delivery claim');
});

test('a model letter that only restates the records is used', async () => {
  const r = byId(fresh(), 'pd_demo_01');
  const complete = async ({ user }) => {
    assert.match(user, /KK-1041/);
    return { text: 'To the reviewer,\nRe: dispute pd_demo_01, 86.00 USD.\nOrder KK-1041 was delivered; see the attached proof.\nKettle & Kiln', model: 'fake-1' };
  };
  const l = await writeLetter(r, { merchant, complete });
  assert.equal(l.source, 'model');
  assert.match(l.note, /fake-1/);
});

test('a model letter with a made-up fact falls back to the template and says why', async () => {
  const r = byId(fresh(), 'pd_demo_04');
  const complete = async () => ({ text: 'Delivered 2026-08-14, tracking 9400111899223. Refund refused.', model: 'fake-1' });
  const l = await writeLetter(r, { merchant, complete });
  assert.equal(l.source, 'template');
  assert.match(l.note, /rejected: "2026-08-14" is in no record; "9400111899223" is in no record; claims "Delivered"/);
  const err = await writeLetter(r, { merchant, complete: async () => { throw new Error('timeout'); } });
  assert.equal(err.source, 'template');
  assert.match(err.note, /model failed: timeout/);
});

test('addLetters puts the letter first in the order snapshot and logs it before the submit', async () => {
  const rs = await addLetters(fresh(), { merchant });
  const chal = rs.filter((r) => r.body?.challenge_details);
  assert.equal(chal.length, 5);
  for (const r of chal) {
    const ids = r.body.challenge_details.evidence.order_snapshot_file_ids;
    assert.equal(ids[0], `doc_${r.dispute.id}_letter`);
    assert.ok(r.gathered.documents.find((d) => d.id === ids[0]).lines.length > 3);
    const steps = r.trail.map((e) => e.step);
    assert.equal(steps.indexOf('letter'), steps.indexOf('submit') - 1);
  }
  assert.equal(rs.filter((r) => r.letter).length, 5);
  assert.match(byId(rs, 'pd_demo_09').letter.text, /Refund/);
});

test('no LLM_* settings means no model', () => {
  assert.equal(completerFromEnv({}), null);
  assert.equal(typeof completerFromEnv({ LLM_BASE_URL: 'http://x/v1', LLM_MODEL: 'm' }), 'function');
});

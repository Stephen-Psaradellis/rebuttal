import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClient } from '../src/client.js';
import { seed, seedPlan, REASON_CODES } from '../src/sandbox.js';
import { processAll } from '../src/run.js';

const load = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8'));
const NOW = new Date('2026-10-28T00:00:00Z');

// A fake sandbox: payments succeed, a simulated dispute comes back in the
// fixture's shape with Airwallex's ids. `refuse` lists reason codes it rejects.
function fakeSandbox({ refuse = [] } = {}) {
  const calls = [];
  const byCode = Object.fromEntries(Object.entries(REASON_CODES).map(([t, c]) => [c, t]));
  let n = 0;
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body });
    const ok = (status, b) => ({ ok: true, status, json: async () => b, headers: { get: () => null } });
    if (path === '/api/v1/authentication/login') return ok(201, { token: 't', expires_at: '2026-10-28T00:30:00Z' });
    if (path === '/api/v1/pa/payment_intents/create') return ok(201, { id: `int_sb_${++n}`, status: 'REQUIRES_PAYMENT_METHOD' });
    if (path.endsWith('/confirm')) return ok(200, { status: 'SUCCEEDED' });
    if (path === '/api/v1/simulation/pa/payment_disputes/create') {
      if (refuse.includes(body.reason_code)) {
        return { ok: false, status: 400, json: async () => ({ code: 'validation_error', message: 'reason_code' }), headers: { get: () => null } };
      }
      return ok(201, { id: `pd_sb_${n}`, payment_intent_id: body.payment_intent_id, status: 'REQUIRES_RESPONSE',
        stage: body.stage, amount: body.amount, currency: 'USD', due_at: body.due_at,
        reason: { type: byCode[body.reason_code] || 'FRAUDULENT', original_code: body.reason_code }, refunds: [] });
    }
    return { ok: false, status: 404, json: async () => ({}), headers: { get: () => null } };
  };
  return { calls, client: createClient({ clientId: 'c', apiKey: 'k', fetch, now: () => NOW.getTime() }) };
}

test('plan keeps each deadline its distance from the fixture day', () => {
  const plan = seedPlan(load('disputes.json'), load('store.json'), { now: NOW, stamp: 1 });
  assert.equal(plan.length, 10);
  assert.ok(plan.every((p) => !p.error));
  const d02 = plan.find((p) => p.fixture === 'pd_demo_02');
  assert.equal(d02.dispute.due_at, '2026-10-29T12:00:00+0000'); // fixture 10-26 12:00 vs 10-25
  assert.equal(d02.dispute.reason_code, '10.4');
  assert.equal(d02.intent.amount, load('store.json').orders.find((o) => o.id === d02.order).total);
});

test('seeded disputes decide exactly as the fixtures do', async () => {
  const { client, calls } = fakeSandbox();
  const s = await seed(client, load('disputes.json'), load('store.json'), { now: NOW });
  assert.equal(s.disputes.length, 10);
  assert.equal(calls.filter((c) => c.path.endsWith('/confirm')).length, 10);
  assert.ok(calls.filter((c) => c.path.endsWith('/confirm')).every((c) => c.body.payment_method.type === 'card'));
  const tally = (rs) => rs.map((r) => r.decision.action).sort().join();
  const fixtureNow = new Date('2026-10-25T00:00:00Z');
  assert.equal(tally(processAll(s.disputes, s.store, { now: NOW })),
    tally(processAll(load('disputes.json'), load('store.json'), { now: fixtureNow })));
});

test('a refused reason code is reported per dispute, the rest still seed', async () => {
  const { client } = fakeSandbox({ refuse: ['13.3'] });
  const s = await seed(client, load('disputes.json'), load('store.json'), { now: NOW });
  const failed = s.report.filter((l) => l.includes('FAILED'));
  assert.equal(failed.length, load('disputes.json').filter((d) => d.reason.type === 'PRODUCT_UNACCEPTABLE').length);
  assert.equal(s.disputes.length, 10 - failed.length);
});

test('simulation is refused outside the sandbox', () => {
  const c = createClient({ clientId: 'c', apiKey: 'k', env: 'prod', fetch: async () => { throw new Error('no'); } });
  assert.throws(() => c.simulateDispute({ payment_intent_id: 'int_x' }), /only in the sandbox/);
});

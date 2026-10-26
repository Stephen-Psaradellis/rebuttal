// Rebuttal - turn the fixture store into real sandbox disputes.
//
//   node src/run.js --sandbox [--submit]     (keys in .env, see .env.example)
//
// For each fixture dispute: create a PaymentIntent for the disputed order's
// total, confirm it with a sandbox test card, then ask the simulation API for a
// dispute on it at the fixture's stage and reason. The store's order is pointed
// at the real PaymentIntent id, so gather() matches records exactly as it does
// on fixtures - only the ids and the clock are Airwallex's.
//
// Read 2026-10-24: POST /api/v1/simulation/pa/payment_disputes/create takes
// payment_intent_id, stage (RFI|PRE_CHARGEBACK|CHARGEBACK|PRE_ARBITRATION),
// reason_code, due_at, amount, comment. The docs' example code is Mastercard
// 4837; their test-reason-code link lands on dispute-response-best-practices
// (read 2026-10-26), whose table lists Visa 10.4/10.5, 11.x, 12.1-12.7, 13.1,
// 13.2, 13.3, 13.4, 13.6, 13.7 - duplicate is 12.6, not Visa's 12.6.1. A code
// still refused on the first run is reported per dispute, never retried.

// Visa codes, since the default test card is a Visa.
export const REASON_CODES = {
  FRAUDULENT: '10.4',
  DUPLICATE_CHARGE: '12.6',
  PRODUCT_NOT_RECEIVED: '13.1',
  PRODUCT_UNACCEPTABLE: '13.3',
  CREDIT_NOT_PROCESSED: '13.6',
  CANCELLED_PRODUCT: '13.7',
};

// Sub-codes the docs' table does not carry fold to their listed parent.
const SUB_CODES = { '12.6.1': '12.6', '12.6.2': '12.6' };
export const sandboxCode = (code) => (code && SUB_CODES[code]) || code;

export const TEST_CARD = {
  number: process.env.AIRWALLEX_TEST_CARD || '4035501000000008',
  expiry_month: '12', expiry_year: '2030', cvc: '123', name: 'Sandbox Shopper',
};

// The fixtures are dated for a 2026-10-25 run; keep each deadline's distance
// from that day so the urgent case is still urgent whenever the seed runs.
const FIXTURE_DAY = Date.parse('2026-10-25T00:00:00Z');
const fmt = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');

// seedPlan -> [{ fixture, order, intent, dispute }] request bodies, no I/O.
export function seedPlan(disputes, store, { now = new Date(), stamp = now.getTime() } = {}) {
  return disputes.map((d) => {
    const order = store.orders.find((o) => o.payment_intent_id === d.payment_intent_id);
    if (!order) return { fixture: d.id, error: `no store order for ${d.payment_intent_id}` };
    const code = sandboxCode(d.reason?.original_code) || REASON_CODES[d.reason?.type];
    if (!code) return { fixture: d.id, error: `no reason code for ${d.reason?.type}` };
    return {
      fixture: d.id,
      order: order.id,
      intent: { request_id: `rebuttal-pi-${order.id}-${stamp}`, amount: order.total, currency: order.currency,
        merchant_order_id: `${order.id}-${stamp}` },
      dispute: { stage: d.stage, reason_code: code, amount: d.amount,
        due_at: fmt(now.getTime() + (Date.parse(d.due_at) - FIXTURE_DAY)),
        comment: `Rebuttal sandbox seed from fixture ${d.id}` },
    };
  });
}

// seed -> { disputes, store, report }: real disputes plus a copy of the store
// whose disputed orders carry the real PaymentIntent ids.
export async function seed(client, disputes, store, { now = new Date(), card = TEST_CARD } = {}) {
  const plan = seedPlan(disputes, store, { now });
  const mapped = structuredClone(store);
  const made = [];
  const report = [];
  for (const p of plan) {
    if (p.error) { report.push(`${p.fixture}: skipped, ${p.error}`); continue; }
    try {
      const pi = await client.createPaymentIntent(p.intent);
      await client.confirmPaymentIntent(pi.id, { request_id: `${p.intent.request_id}-c`,
        payment_method: { type: 'card', card } });
      const dispute = await client.simulateDispute({ ...p.dispute, payment_intent_id: pi.id });
      mapped.orders.find((o) => o.id === p.order).payment_intent_id = pi.id;
      made.push(dispute);
      report.push(`${p.fixture}: ${dispute.id} on ${pi.id} (${p.dispute.stage} ${p.dispute.reason_code})`);
    } catch (e) {
      report.push(`${p.fixture}: FAILED ${e.message}`);
    }
  }
  return { disputes: made, store: mapped, report };
}

// verdicts -> report lines: after --submit, play the issuer for every disputed
// case we challenged. MERCHANT or CUSTOMER resolves it; ESCALATE declines the
// evidence. Accepted cases are already closed and are left alone. This is a
// simulated outcome, never evidence the letters win real disputes.
export async function verdicts(client, results, outcome) {
  const report = [];
  for (const r of results.filter((x) => x.decision.action === 'challenge')) {
    const id = r.dispute.id;
    try {
      const out = outcome === 'ESCALATE'
        ? await client.simulateEscalate(id, { comment: 'Rebuttal sandbox: issuer declines the evidence' })
        : await client.simulateResolve(id, { in_favor_of: outcome, comment: 'Rebuttal sandbox: simulated issuer verdict' });
      report.push(`${id}: ${outcome} -> ${out.status}${out.stage ? ` (${out.stage})` : ''}`);
    } catch (e) {
      report.push(`${id}: FAILED ${e.message}`);
    }
  }
  return report;
}

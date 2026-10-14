// Rebuttal - one pass over the open disputes, with an audit trail.
//
//   node src/run.js [--now 2026-10-25T00:00:00Z] [--json]
//
// Reads fixtures/ (a fictional store and ten disputes in Airwallex's object
// shape) until the sandbox client lands; every POST body is built and
// validated but NOT sent - each submit step says "dry run".

import { readFileSync } from 'node:fs';
import { decide, challengeBody, acceptBody, DEFAULT_POLICY } from './rules.js';
import { gather, packFor } from './evidence.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

// processAll -> [{ dispute, decision, gathered, body, trail }]; trail entries are
// { step, detail } so the merchant can replay "why did it accept this one?".
export function processAll(disputes, store, { now = new Date(), policy = DEFAULT_POLICY } = {}) {
  return disputes.map((dispute) => {
    const trail = [];
    const log = (step, detail) => trail.push({ step, detail });
    log('fetch', `${dispute.id} ${dispute.reason?.type} ${dispute.stage} ${dispute.status}, `
      + `${Number(dispute.amount).toFixed(2)} ${dispute.currency}, due ${dispute.due_at}`);
    const gathered = gather(dispute, store, disputes);
    for (const n of gathered.notes) log('gather', n);
    const decision = decide(dispute, gathered.evidence, policy, now);
    log('decide', `${decision.action}${decision.reason ? ` (${decision.reason})` : ''}: ${decision.why}`
      + `${decision.urgent ? ' [URGENT]' : ''}`);
    let body = null;
    const requestId = `rebuttal-${dispute.id}-${now.toISOString().slice(0, 10)}`;
    if (decision.action === 'CHALLENGE') {
      body = challengeBody(dispute, decision, packFor(decision, gathered.evidence), requestId);
      log('submit', `dry run: POST /api/v1/pa/payment_disputes/${dispute.id}/challenge with `
        + `${Object.keys(body.challenge_details.evidence).length} evidence field(s)`);
    } else if (decision.action === 'ACCEPT') {
      body = acceptBody(dispute, decision, requestId);
      log('submit', `dry run: POST /api/v1/pa/payment_disputes/${dispute.id}/accept (${body.reason})`);
    } else if (decision.action === 'ESCALATE') {
      log('escalate', 'case card sent to the merchant; nothing is submitted without them');
    }
    return { dispute, decision, gathered, body, trail };
  });
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('run.js')) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--now');
  const now = i >= 0 ? new Date(args[i + 1]) : new Date();
  const results = processAll(load('disputes.json'), load('store.json'), { now });
  if (args.includes('--json')) {
    console.log(JSON.stringify(results.map(({ dispute, decision, body, trail }) => ({ id: dispute.id, decision, body, trail })), null, 2));
  } else {
    for (const r of results) {
      console.log(`\n${r.dispute.id}  ${r.decision.action}`);
      for (const e of r.trail) console.log(`  ${e.step.padEnd(8)} ${e.detail}`);
    }
    const tally = results.reduce((m, r) => ({ ...m, [r.decision.action]: (m[r.decision.action] || 0) + 1 }), {});
    console.log(`\n${results.length} disputes: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }
}

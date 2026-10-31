// Rebuttal - the merchant's case board.
//
//   node src/board.js [--now 2026-10-25T00:00:00Z] [--out site/]
//   node src/board.js --seed out/sandbox-seed.json   the real sandbox disputes of a --paid run
//
// One static page over a pass of processAll(): every open dispute as a card,
// cases that need the merchant first, then by deadline. Each card says what the
// agent decided and why, which evidence fields it would send (with the rendered
// pages the File Service would receive), what is missing, the audit trail and
// the exact POST body. Nothing on the page is a claim the records do not hold:
// it is the same trail run.js prints, laid out for a person.
//
// boardHtml() is pure (results in, HTML out) so tests need no files.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processAll } from './run.js';
import { toPng, attached } from './render.js';
import { addLetters, completerFromEnv } from './letter.js';
import { fromSeed } from './sandbox.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Who has to act next. ESCALATE is the merchant's; an urgent case of any kind
// rides above the rest because the deadline is the one thing nobody can extend.
const RANK = { ESCALATE: 0, CHALLENGE: 1, ACCEPT: 2, NONE: 3 };
export function order(results) {
  return [...results].sort((a, b) => (b.decision.urgent - a.decision.urgent)
    || (RANK[a.decision.action] - RANK[b.decision.action])
    || (Date.parse(a.dispute.due_at || 0) - Date.parse(b.dispute.due_at || 0)));
}

const LABEL = {
  ESCALATE: 'Needs you', CHALLENGE: 'Challenge', ACCEPT: 'Accept', NONE: 'No action',
};

const money = (n, cur) => `${Number(n || 0).toFixed(2)} ${esc(cur)}`;

function dueText(d) {
  if (d.hoursLeft === null || d.hoursLeft === undefined) return 'no deadline given';
  if (d.hoursLeft <= 0) return 'deadline passed';
  const h = Math.floor(d.hoursLeft);
  return h >= 48 ? `${Math.floor(h / 24)} days left` : `${h} hours left`;
}

export function totals(results) {
  const t = { count: results.length, stake: 0, challenged: 0, accepted: 0, escalated: 0, byAction: {} };
  for (const { dispute, decision } of results) {
    const amt = Number(dispute.amount) || 0;
    if (dispute.status === 'REQUIRES_RESPONSE') t.stake += amt;
    if (decision.action === 'CHALLENGE') t.challenged += amt;
    if (decision.action === 'ACCEPT') t.accepted += amt;
    if (decision.action === 'ESCALATE') t.escalated += amt;
    t.byAction[decision.action] = (t.byAction[decision.action] || 0) + 1;
  }
  return t;
}

function card(r, images, sandbox = null) {
  const { dispute: d, decision: dec, body, trail } = r;
  const ev = body?.challenge_details?.evidence || {};
  const fields = Object.entries(ev).map(([k, v]) => {
    const pics = (Array.isArray(v) ? v : []).flatMap((id) => images[id] || []);
    const val = Array.isArray(v)
      ? (pics.length ? pics.map((p) => `<a href="${esc(p)}" target="_blank" rel="noopener">${esc(p.split('/').pop())}</a>`).join(' ')
        : v.map(esc).join(', '))
      : esc(v);
    return `<li><code>${esc(k)}</code><span>${val}</span></li>`;
  }).join('');
  const missing = (dec.missing || []).map((m) => `<li><code>${esc(Array.isArray(m) ? m.join(' or ') : m)}</code></li>`).join('');
  const steps = trail.map((e) => `<li><b>${esc(e.step)}</b> ${esc(e.detail)}</li>`).join('');
  return `<article class="case a-${esc(dec.action)}${dec.urgent ? ' urgent' : ''}" id="${esc(d.id)}">
  <header>
    <span class="badge">${esc(LABEL[dec.action] || dec.action)}</span>
    ${dec.urgent ? '<span class="badge hot">Urgent</span>' : ''}
    <span class="amt">${money(d.amount, d.currency)}</span>
  </header>
  <h2>${esc(d.reason?.type || 'UNKNOWN')} <small>${esc(d.reason?.original_code || '')}</small></h2>
  <p class="meta"><code>${esc(d.id)}</code> &middot; ${esc(d.stage)} &middot; ${esc(dueText(dec))}</p>
  <p class="why">${esc(dec.why)}${dec.reason ? ` <span class="reason">(${esc(dec.reason)})</span>` : ''}</p>
  ${fields ? `<h3>Evidence it would send</h3><ul class="fields">${fields}</ul>` : ''}
  ${r.letter ? `<details class="letter"><summary>Rebuttal letter (${r.letter.source === 'model' ? 'model-written, fact-checked' : 'template'})</summary><pre>${esc(r.letter.text)}</pre><p class="meta">${esc(r.letter.note)}</p></details>` : ''}
  ${missing ? `<h3>Missing</h3><ul class="fields miss">${missing}</ul>` : ''}
  <details><summary>Audit trail (${trail.length} steps)</summary><ol class="trail">${steps}</ol></details>
  ${body ? `<details><summary>Request body (${sandbox ? 'submitted to the Airwallex sandbox' : 'dry run, not sent'})</summary><pre>${esc(JSON.stringify(body, null, 2))}</pre></details>` : ''}
</article>`;
}

// images: { doc_id: ['evidence/doc_x.png', ...] } - pages already written.
export function boardHtml(results, { merchant = 'Demo store', generatedAt = '', demo = true, images = {}, sandbox = null } = {}) {
  const t = totals(results);
  const cur = esc(results[0]?.dispute.currency || '');
  const tally = ['ESCALATE', 'CHALLENGE', 'ACCEPT', 'NONE']
    .map((a) => `<div class="tile"><b>${t.byAction[a] || 0}</b><span>${LABEL[a]}</span></div>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rebuttal case board</title>
<meta name="description" content="Dispute Response Agent for Airwallex: every open dispute, what the agent decided, and the evidence behind it.">
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--mute:#5f5f5a;--line:#e3e2dd;--esc:#b4232a;--chal:#1f5fbf;--acc:#5f6b2b;--none:#7a7a74;--hot:#b4232a}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#21211f;--ink:#ecebe6;--mute:#a3a29b;--line:#34332f;--esc:#f0767b;--chal:#7fb0ff;--acc:#b9c77a;--none:#9a9992;--hot:#f0767b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.6rem;margin:0 0 4px}.sub{color:var(--mute);margin:0 0 18px}
.note{border:1px solid var(--line);background:var(--card);padding:10px 14px;border-radius:8px;color:var(--mute);font-size:.9rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:18px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.tile b{display:block;font-size:1.4rem}.tile span{color:var(--mute);font-size:.85rem}
.case{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--none);border-radius:8px;padding:14px 16px;margin:12px 0}
.a-ESCALATE{border-left-color:var(--esc)}.a-CHALLENGE{border-left-color:var(--chal)}.a-ACCEPT{border-left-color:var(--acc)}
.case header{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.badge{font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:99px;border:1px solid currentColor}
.a-ESCALATE .badge{color:var(--esc)}.a-CHALLENGE .badge{color:var(--chal)}.a-ACCEPT .badge{color:var(--acc)}.a-NONE .badge{color:var(--none)}
.badge.hot{color:var(--hot)!important}.amt{margin-left:auto;font-weight:600}
h2{font-size:1.05rem;margin:8px 0 2px}h2 small{color:var(--mute);font-weight:400}
h3{font-size:.85rem;margin:12px 0 4px;color:var(--mute);text-transform:uppercase;letter-spacing:.04em}
.meta{color:var(--mute);margin:0;font-size:.88rem}.why{margin:8px 0 0}.reason{color:var(--mute)}
.fields{list-style:none;margin:0;padding:0}.fields li{display:flex;gap:10px;flex-wrap:wrap;padding:3px 0;border-top:1px solid var(--line)}
.fields code{min-width:min(260px,100%);color:var(--mute)}.fields span{overflow-wrap:anywhere}.miss code{color:var(--esc)}
a{color:var(--chal)}details{margin-top:10px}summary{cursor:pointer;color:var(--mute)}
.trail{margin:6px 0 0;padding-left:20px;font-size:.88rem}details.letter pre{white-space:pre-wrap;font-family:inherit;font-size:.9rem}pre{overflow:auto;background:var(--bg);padding:10px;border-radius:6px;font-size:.8rem;max-width:100%}
footer{color:var(--mute);font-size:.85rem;margin-top:28px}
</style></head><body><main>
<h1>Rebuttal case board</h1>
<p class="sub">${esc(merchant)} &middot; ${results.length} disputes &middot; run ${esc(generatedAt)}</p>
${sandbox ? `<p class="note">Airwallex sandbox: these are real sandbox disputes (dst_ ids), simulated on test-card payments at ${esc(sandbox)} over a fictional store. The board shows what the agent decided before submitting; <code>node src/run.js --sandbox --paid --submit</code> then sent each body to the sandbox. Built by an AI agent (Claude) for the Airwallex Agentic Banking hackathon.</p>` : demo ? `<p class="note">Demo data: a fictional store and ten disputes in Airwallex's payment_disputes shape. This is a dry run - every request body below is built and checked but nothing is sent. Built by an AI agent (Claude) for the Airwallex Agentic Banking hackathon.</p>` : ''}
<div class="tiles">${tally}
<div class="tile"><b>${t.stake.toFixed(2)}</b><span>${cur} open</span></div>
<div class="tile"><b>${t.challenged.toFixed(2)}</b><span>${cur} being fought</span></div></div>
${order(results).map((r) => card(r, images, sandbox)).join('\n')}
<footer>Source: <a href="https://github.com/Stephen-Psaradellis/rebuttal">github.com/Stephen-Psaradellis/rebuttal</a> (MIT). The agent never challenges with required evidence missing, never accepts above the merchant's limit, hands arbitration stages to a person, and sends a model-written rebuttal letter only when every figure in it appears in the attached records.</footer>
</main></body></html>
`;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/board.js')) {
  const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
  const args = process.argv.slice(2);
  const arg = (k, dflt) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : dflt);
  const now = new Date(arg('--now', new Date().toISOString()));
  const outDir = arg('--out', 'site');
  const seedPath = arg('--seed', null);
  let seededAt = null;
  let disputes = load('disputes.json');
  let store = load('store.json');
  if (seedPath) {
    const seedFile = JSON.parse(readFileSync(seedPath, 'utf8'));
    seededAt = seedFile.at;
    ({ disputes, store } = fromSeed(seedFile, JSON.parse(readFileSync(arg('--intents', 'out/intents.json'), 'utf8')), store));
  }
  const results = processAll(disputes, store, { now });
  await addLetters(results, { merchant: store.store?.name, complete: completerFromEnv() });
  const meta = { merchant: store.store?.name, generatedAt: now.toISOString().slice(0, 10) };
  mkdirSync(join(outDir, 'evidence'), { recursive: true });
  const images = {};
  for (const x of results.filter((x) => x.body?.challenge_details)) {
    for (const doc of attached(x.gathered.documents, x.body.challenge_details.evidence)) {
      for (const png of await toPng(doc, { ...meta, disputeId: x.dispute.id })) {
        writeFileSync(join(outDir, 'evidence', png.name), png.bytes);
        (images[doc.id] ||= []).push(`evidence/${png.name}`);
      }
    }
  }
  writeFileSync(join(outDir, 'index.html'), boardHtml(results, { ...meta, images, sandbox: seededAt }));
  console.log(`board: ${outDir}/index.html, ${Object.values(images).flat().length} evidence page(s)`);
}

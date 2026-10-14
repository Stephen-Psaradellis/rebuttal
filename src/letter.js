// Rebuttal - the rebuttal letter (APPLICATION.md, step 4: "builds the evidence
// pack and the rebuttal letter").
//
// The one place a language model writes. Each challenge gets a one-page cover
// letter to the issuer's reviewer, and the model may only restate records the
// gatherer already attached. Before a model letter is used it is checked:
//
//   - every number, date, id, tracking code, email address and IP in it must
//     appear in those records;
//   - it may not claim a delivery, a sign-in or an earlier win that no attached
//     document shows.
//
// A letter that fails either check is thrown away and a plain template letter,
// built from the same records, goes instead. No model configured, a timeout or
// an error does the same. The trail says which letter went and why, so a
// merchant can see that nothing in the pack was made up.
//
// The letter is page 1 of the order snapshot (order_snapshot_file_ids), the
// field every challenge carries, so it reaches the reviewer through the same
// File Service upload as the rest of the pack.

const money = (n, cur) => `${Number(n).toFixed(2)} ${cur}`;
const label = (field) => field.replace(/_file_ids$/, '').replace(/_/g, ' ');

// Tokens a reviewer would check against the evidence: ISO dates/timestamps,
// emails, IPv4s, and any word containing a digit (ids, tracking, amounts).
const TOKEN = /\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:\d{1,3}\.){3}\d{1,3}|[A-Za-z_#$-]*\d[\w.,/-]*/g;
const clean = (tok) => tok.replace(/^[$#]+/, '').replace(/[.,/-]+$/, '').toLowerCase();
const numeric = (tok) => (/^\d[\d,]*(\.\d+)?$/.test(tok) ? Number(tok.replace(/,/g, '')) : null);

// Claims that need a document behind them: [pattern, fields any one of which backs it].
const CLAIMS = [
  // 'delivered' is the claim; 'delivery' alone is usually the policy or terms being quoted.
  [/\bdelivered\b/i,['order_fulfillment_file_ids', 'duplicate_payment_file_ids']],
  [/\b(?:signed|logged) in\b|\blog-?ins?\b|\bsign-?ins?\b/i, ['access_activity_file_ids']],
  [/\b(?:won|prevailed)\b/i, ['previous_dispute_won_on_same_card_file_ids']],
];

// The records the letter may draw on: the dispute itself, the decision, the
// text fields and every attached document's lines.
export function facts(result, merchant = '') {
  const { dispute: d, decision, gathered, body } = result;
  const ev = body?.challenge_details?.evidence || {};
  const ids = new Set(Object.values(ev).filter(Array.isArray).flat());
  const docs = gathered.documents.filter((doc) => ids.has(doc.id));
  const refunds = (d.refunds || []).map((r) => `Refund ${money(r.amount, d.currency)} on ${r.created_at || '?'}${r.id ? ` (${r.id})` : ''}`);
  return {
    header: [
      `Merchant: ${merchant}`,
      `Dispute ${d.id} on payment ${d.payment_intent_id}: ${money(d.amount, d.currency)}, reason ${d.reason?.type} (network code ${d.reason?.original_code || '?'}), stage ${d.stage}, response due ${d.due_at}`,
      `Challenge reason: ${decision.reason}`,
      ...refunds,
    ],
    text: Object.entries(ev).filter(([, v]) => typeof v === 'string').map(([k, v]) => `${label(k)}: ${v}`),
    docs: docs.map((doc) => ({ field: doc.field, title: doc.title, lines: doc.lines.filter(Boolean) })),
    fields: Object.keys(ev),
  };
}

const corpusOf = (f) => [...f.header, ...f.text, ...f.docs.flatMap((doc) => [doc.title, ...doc.lines])].join('\n');

// check(letter, facts) -> { ok, unsupported: [tokens], claims: [phrases] }
export function check(letter, f) {
  const corpus = corpusOf(f);
  const have = new Set((corpus.match(TOKEN) || []).map(clean));
  const nums = new Set([...have].map(numeric).filter((n) => n !== null));
  for (const tok of have) {
    const date = tok.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (date) { have.add(date[0]); nums.add(Number(date[1])); }
  }
  const unsupported = [];
  for (const raw of letter.match(TOKEN) || []) {
    const tok = clean(raw);
    if (!tok || have.has(tok)) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(tok) && have.has(tok.slice(0, 10))) continue;
    const n = numeric(tok);
    if (n !== null && nums.has(n)) continue;
    const shown = raw.replace(/[.,/-]+$/, '');
    if (!unsupported.includes(shown)) unsupported.push(shown);
  }
  const claims = CLAIMS.filter(([re, backers]) => re.test(letter) && !backers.some((b) => f.fields.includes(b)))
    .map(([re]) => letter.match(re)[0]);
  return { ok: !unsupported.length && !claims.length, unsupported, claims };
}

export function templateLetter(f, result) {
  const { dispute: d, decision, body } = result;
  const ev = body?.challenge_details?.evidence || {};
  const lines = [
    "To the card issuer's dispute reviewer,",
    '',
    `Re: dispute ${d.id} on payment ${d.payment_intent_id}, ${money(d.amount, d.currency)}, reason ${d.reason?.type} (code ${d.reason?.original_code || '?'}).`,
    '',
    `${f.header[0].replace(/^Merchant: /, '') || 'The merchant'} asks that this dispute be reversed (${decision.reason}). ${decision.why}.`,
  ];
  if (ev.duplicate_explanation) lines.push('', ev.duplicate_explanation);
  for (const r of f.header.filter((h) => h.startsWith('Refund '))) lines.push('', `${r}, issued before the dispute was resolved.`);
  if (f.docs.length) {
    lines.push('', 'Attached:');
    for (const doc of f.docs) lines.push(`- ${doc.title} (${label(doc.field)})`);
  }
  if (ev.merchant_business_model_description) lines.push('', `About us: ${ev.merchant_business_model_description}`);
  return lines.join('\n');
}

const SYSTEM = `You write the cover letter a small online merchant sends with a chargeback response.
Rules: use ONLY the records given. Copy every date, amount, id, tracking code, email and IP exactly as written in the records - never round, reformat or add one.
Never claim delivery, a sign-in or an earlier dispute win unless a record shows it. No threats, no guesses about the cardholder's motives.
Plain text, at most 200 words: a one-line greeting to the issuer's dispute reviewer, a Re: line, two or three short paragraphs that walk the reviewer through why the evidence answers this reason code, then the merchant's name.`;

function prompt(f) {
  return [
    ...f.header,
    ...f.text,
    'Attached documents:',
    ...f.docs.map((doc) => `## ${doc.title} [${label(doc.field)}]\n${doc.lines.join('\n')}`),
  ].join('\n');
}

// An OpenAI-compatible chat client from LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
// (OpenAI, Groq, OpenRouter, a local Ollama...). None set -> null -> templates.
export function completerFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  if (!env.LLM_BASE_URL || !env.LLM_MODEL) return null;
  const timeout = Number(env.LLM_TIMEOUT_MS || 60000);
  return async ({ system, user }) => {
    const headers = { 'Content-Type': 'application/json' };
    if (env.LLM_API_KEY) headers.Authorization = `Bearer ${env.LLM_API_KEY}`;
    const res = await fetchImpl(`${env.LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers, signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({ model: env.LLM_MODEL, temperature: 0.2, max_tokens: 600,
        ...(env.LLM_REASONING_EFFORT ? { reasoning_effort: env.LLM_REASONING_EFFORT } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`model HTTP ${res.status}`);
    const j = await res.json();
    return { text: String(j.choices?.[0]?.message?.content || '').trim(), model: j.model || env.LLM_MODEL };
  };
}

// writeLetter -> { text, source: 'model' | 'template', model?, note }
export async function writeLetter(result, { merchant = '', complete = null } = {}) {
  const f = facts(result, merchant);
  const fallback = (note) => ({ text: templateLetter(f, result), source: 'template', note });
  if (!complete) return fallback('template letter (no model configured)');
  let out;
  try {
    out = await complete({ system: SYSTEM, user: prompt(f) });
  } catch (e) {
    return fallback(`template letter (model failed: ${e.message})`);
  }
  const text = (out?.text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) return fallback('template letter (model returned nothing)');
  const c = check(text, f);
  if (!c.ok) {
    const why = [...c.unsupported.map((t) => `"${t}" is in no record`), ...c.claims.map((t) => `claims "${t}" with no document`)];
    return fallback(`template letter (model letter rejected: ${why.slice(0, 3).join('; ')})`);
  }
  return { text, source: 'model', model: out.model, note: `written by ${out.model}; every figure checked against the attached records` };
}

// addLetters(results, opts): for each challenge, write the letter, attach it as
// page 1 of the order snapshot and log it. Mutates and returns results.
export async function addLetters(results, opts = {}) {
  for (const r of results) {
    const ev = r.body?.challenge_details?.evidence;
    if (!ev) continue;
    const letter = await writeLetter(r, opts);
    const id = `doc_${r.dispute.id}_letter`;
    r.gathered.documents.unshift({ id, field: 'order_snapshot_file_ids', title: `Merchant response to dispute ${r.dispute.id}`,
      lines: letter.text.split('\n') });
    ev.order_snapshot_file_ids = [id, ...(ev.order_snapshot_file_ids || [])];
    r.letter = letter;
    const at = r.trail.findIndex((e) => e.step === 'submit');
    r.trail.splice(at < 0 ? r.trail.length : at, 0, { step: 'letter', detail: letter.note });
  }
  return results;
}

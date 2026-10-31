// Rebuttal - the Airwallex client: auth, disputes, File Service, submit.
//
// Read 2026-10-14 from airwallex.com/docs/api:
//   POST /api/v1/authentication/login   x-client-id + x-api-key -> 201 { token, expires_at }
//        token lives 30 min; reuse it until expires_at, never log in per call.
//   GET  /api/v1/pa/payment_disputes    ?status&stage&from_due_at...&page&size
//        -> { items, page_after, page_before }; page after the first = page_after.
//   GET  /api/v1/pa/payment_disputes/{id}
//   POST /api/v1/pa/payment_disputes/{id}/challenge | /accept
//   POST https://files.<env>.airwallex.com/api/v1/files/upload   multipart file + notes
//        -> 201 { file_id, filename, size }; filename and notes <= 50 chars, 20MB.
// fetch is injected so the whole client runs against a fake in tests and in the
// dry run; nothing here reads keys from disk.

const HOSTS = {
  sandbox: { api: 'https://api.sandbox.airwallex.com', files: 'https://files.sandbox.airwallex.com' },
  prod: { api: 'https://api.airwallex.com', files: 'https://files.airwallex.com' },
};
const MAX_UPLOAD = 20 * 1024 * 1024;
const SKEW_MS = 60 * 1000; // re-login a minute early rather than race the expiry

export class AirwallexError extends Error {
  constructor(status, body, where) {
    super(`${where}: HTTP ${status}${body?.code ? ` ${body.code}` : ''}${body?.message ? ` - ${body.message}` : ''}`);
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip50 = (s) => String(s).slice(0, 50);
// A file name is clipped from the middle: the Files API checks the extension
// (invalid_file_extension, measured 2026-10-31 on a 54-char evidence name).
const clipName = (s) => {
  const name = String(s);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
  return name.length <= 50 ? name : name.slice(0, 50 - ext.length) + ext;
};

export function createClient({ clientId, apiKey, env = 'sandbox', fetch = globalThis.fetch,
  now = () => Date.now(), wait = sleep, maxRetries = 2 } = {}) {
  if (!clientId || !apiKey) throw new Error('clientId and apiKey are required');
  const host = HOSTS[env];
  if (!host) throw new Error(`unknown env ${env}`);
  let token = null;
  let expiresAt = 0;
  let logins = 0;

  async function login() {
    const res = await fetch(`${host.api}/api/v1/authentication/login`, {
      method: 'POST', headers: { 'x-client-id': clientId, 'x-api-key': apiKey },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new AirwallexError(res.status, body, 'login');
    token = body.token;
    expiresAt = Date.parse(body.expires_at) || now() + 30 * 60 * 1000;
    logins++;
  }

  // One call with the token, re-logging in on expiry and backing off on 429.
  async function call(method, url, { json, form, where } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (!token || now() >= expiresAt - SKEW_MS) await login();
      const headers = { authorization: `Bearer ${token}` };
      let body;
      if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
      if (form) body = form();
      const res = await fetch(url, { method, headers, body });
      const out = await res.json().catch(() => ({}));
      if (res.ok) return out;
      if (attempt < maxRetries && res.status === 401 && out.code === 'credentials_expired') {
        token = null;
        continue;
      }
      if (attempt < maxRetries && res.status === 429) {
        const after = Number(res.headers?.get?.('retry-after'));
        await wait(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      throw new AirwallexError(res.status, out, where || `${method} ${url}`);
    }
  }

  const q = (params) => {
    const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();
    return s ? `?${s}` : '';
  };

  return {
    get logins() { return logins; },

    // Every dispute matching the filters, following page_after to the end.
    async listDisputes(filters = {}, { size = 100, maxPages = 50 } = {}) {
      const items = [];
      let page;
      for (let n = 0; n < maxPages; n++) {
        const r = await call('GET', `${host.api}/api/v1/pa/payment_disputes${q({ ...filters, size, page })}`,
          { where: 'list disputes' });
        items.push(...(r.items || []));
        if (!r.page_after || !(r.items || []).length || r.page_after === page) return items;
        page = r.page_after;
      }
      return items;
    },

    getDispute: (id) => call('GET', `${host.api}/api/v1/pa/payment_disputes/${encodeURIComponent(id)}`,
      { where: `get ${id}` }),

    async uploadFile(name, bytes, notes) {
      if (bytes.length > MAX_UPLOAD) throw new Error(`${name} is ${bytes.length} bytes, over the 20MB upload limit`);
      const form = () => {
        const fd = new FormData();
        fd.append('file', new Blob([bytes], { type: name.endsWith('.png') ? 'image/png' : name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream' }), clipName(name));
        if (notes) fd.append('notes', clip50(notes));
        return fd;
      };
      return call('POST', `${host.files}/api/v1/files/upload`, { form, where: `upload ${name}` });
    },

    challenge: (id, body) => call('POST', `${host.api}/api/v1/pa/payment_disputes/${encodeURIComponent(id)}/challenge`,
      { json: body, where: `challenge ${id}` }),
    accept: (id, body) => call('POST', `${host.api}/api/v1/pa/payment_disputes/${encodeURIComponent(id)}/accept`,
      { json: body, where: `accept ${id}` }),

    // Payments + the sandbox-only simulation API (read 2026-10-24 from
    // docs/developer-tools/sandbox-environment/payments/simulate-payment-disputes),
    // used by src/sandbox.js to make real disputes to answer.
    createPaymentIntent: (body) => call('POST', `${host.api}/api/v1/pa/payment_intents/create`,
      { json: body, where: `create payment ${body.merchant_order_id}` }),
    getPaymentIntent: (id) => call('GET', `${host.api}/api/v1/pa/payment_intents/${encodeURIComponent(id)}`,
      { where: `get payment ${id}` }),
    confirmPaymentIntent: (id, body) => call('POST', `${host.api}/api/v1/pa/payment_intents/${encodeURIComponent(id)}/confirm`,
      { json: body, where: `confirm ${id}` }),
    simulateDispute(body) {
      if (env !== 'sandbox') throw new Error('simulation endpoints exist only in the sandbox');
      return call('POST', `${host.api}/api/v1/simulation/pa/payment_disputes/create`,
        { json: body, where: `simulate dispute on ${body.payment_intent_id}` });
    },
    // The issuer's side of a simulated dispute: resolve takes in_favor_of
    // MERCHANT (-> WON/REVERSED) or CUSTOMER (-> LOST); escalate declines the
    // evidence and moves the case to its next stage.
    simulateResolve(id, body) {
      if (env !== 'sandbox') throw new Error('simulation endpoints exist only in the sandbox');
      return call('POST', `${host.api}/api/v1/simulation/pa/payment_disputes/${encodeURIComponent(id)}/resolve`,
        { json: body, where: `simulate resolve ${id}` });
    },
    simulateEscalate(id, body) {
      if (env !== 'sandbox') throw new Error('simulation endpoints exist only in the sandbox');
      return call('POST', `${host.api}/api/v1/simulation/pa/payment_disputes/${encodeURIComponent(id)}/escalate`,
        { json: body, where: `simulate escalate ${id}` });
    },
  };
}

// The challenge body names our document ids (doc_*); Airwallex wants File
// Service ids. A multi-page document becomes several images, so one doc id can
// expand to several file ids, in page order. An id with no upload is an error:
// sending a challenge that points at nothing would lose the case quietly.
export function swapFileIds(body, uploaded) {
  const evidence = {};
  for (const [k, v] of Object.entries(body.challenge_details.evidence)) {
    if (!Array.isArray(v)) { evidence[k] = v; continue; }
    evidence[k] = v.flatMap((docId) => {
      const ids = uploaded[docId];
      if (!ids?.length) throw new Error(`${k}: document ${docId} was not uploaded`);
      return ids;
    });
  }
  return { ...body, challenge_details: { ...body.challenge_details, evidence } };
}

// Which documents[].type each evidence file field becomes. PRIMARY is the proof
// the challenge reason rests on, ORDER the purchase itself, CUSTOMER what the
// cardholder said or agreed to.
const DOC_TYPES = {
  order_fulfillment_file_ids: 'PRIMARY', product_consumption_file_ids: 'PRIMARY',
  authenticity_proof_file_ids: 'PRIMARY', duplicate_payment_file_ids: 'PRIMARY', access_activity_file_ids: 'PRIMARY',
  order_snapshot_file_ids: 'ORDER', product_snapshot_file_ids: 'ORDER',
  previous_purchase_similar_product_file_ids: 'ORDER', previous_dispute_won_on_same_card_file_ids: 'ORDER',
  customer_communication_file_ids: 'CUSTOMER', user_agreement_file_ids: 'CUSTOMER',
  refund_policy_file_ids: 'OTHER',
};

// toWire -> the body the challenge endpoint takes. Our internal body nests
// everything under challenge_details.evidence; that `evidence` object is only
// read with challenge_method AI_DISPUTE_AUTOMATION. A STANDARD challenge is flat
// (reason, stage, product_type, delivery_info, supporting_documents.documents),
// and without product_type the API refuses it ("Valid product_type must be
// provided", measured 2026-10-31; raw/airwallex-api-payment-disputes-challenge-20261031.md).
export function toWire(body, letter = '') {
  const { reason, stage, product_type: productType, evidence = {} } = body.challenge_details;
  const notes = [];
  const documents = [];
  for (const [k, v] of Object.entries(evidence)) {
    if (Array.isArray(v)) {
      documents.push({ type: DOC_TYPES[k] || 'OTHER', description: k.replace(/_file_ids$/, '').replace(/_/g, ' '), file_ids: v });
    } else if (k !== 'order_fulfilled_at' && k !== 'product_description') {
      notes.push(`${k.replace(/_/g, ' ')}: ${v}`);
    }
  }
  const out = { request_id: body.request_id, challenge_method: 'STANDARD', reason, stage };
  if (productType) out.product_type = productType;
  if (evidence.product_description) out.product_description = evidence.product_description;
  if (evidence.order_fulfilled_at) {
    const at = String(evidence.order_fulfilled_at);
    out.delivery_info = { delivered_at: at.length === 10 ? `${at}T00:00:00Z` : at };
  }
  const description = [letter, ...notes].filter(Boolean).join('\n\n');
  if (description) out.description = description;
  if (documents.length) out.supporting_documents = { documents };
  return out;
}

// Upload each rendered page, swap the ids in, post the challenge. `pages` is
// { docId: [{ name, bytes }] } from render.toPng. Returns the upload map, the
// body as sent and Airwallex's reply so the audit trail can name every file.
export async function submitChallenge(client, disputeId, body, pages, { letter = '' } = {}) {
  const uploaded = {};
  for (const [docId, list] of Object.entries(pages)) {
    uploaded[docId] = [];
    for (const p of list) {
      const r = await client.uploadFile(p.name, p.bytes, `${disputeId} ${docId}`);
      uploaded[docId].push(r.file_id);
    }
  }
  const final = toWire(swapFileIds(body, uploaded), letter);
  const reply = await client.challenge(disputeId, final);
  return { uploaded, body: final, reply };
}

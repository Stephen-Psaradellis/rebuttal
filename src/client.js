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
        fd.append('file', new Blob([bytes], { type: name.endsWith('.png') ? 'image/png' : 'application/octet-stream' }), clip50(name));
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

// Upload each rendered page, swap the ids in, post the challenge. `pages` is
// { docId: [{ name, bytes }] } from render.toPng. Returns the upload map and
// Airwallex's reply so the audit trail can name every file it sent.
export async function submitChallenge(client, disputeId, body, pages) {
  const uploaded = {};
  for (const [docId, list] of Object.entries(pages)) {
    uploaded[docId] = [];
    for (const p of list) {
      const r = await client.uploadFile(p.name, p.bytes, `${disputeId} ${docId}`);
      uploaded[docId].push(r.file_id);
    }
  }
  const final = swapFileIds(body, uploaded);
  const reply = await client.challenge(disputeId, final);
  return { uploaded, body: final, reply };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, swapFileIds, submitChallenge, AirwallexError } from '../src/client.js';

// A fake Airwallex: records every request, answers from `routes`.
function fake(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method || 'GET', host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams),
      headers: init.headers || {}, body: init.body };
    calls.push(call);
    const key = `${call.method} ${u.pathname}`;
    const h = routes[key];
    if (!h) return resp(404, { code: 'not_found', message: key });
    const [status, body, headers] = h(call, calls);
    return resp(status, body, headers);
  };
  return { fetch, calls };
}
const resp = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});
const login = (expires = '2026-10-25T00:30:00Z') => () => [201, { token: 'tok', expires_at: expires }];
const opts = (f, t = Date.parse('2026-10-25T00:00:00Z')) => ({ clientId: 'cid', apiKey: 'key', fetch: f.fetch,
  now: () => t, wait: async () => {} });

test('logs in once with the two headers and reuses the token', async () => {
  const f = fake({
    'POST /api/v1/authentication/login': login(),
    'GET /api/v1/pa/payment_disputes/d1': () => [200, { id: 'd1' }],
  });
  const c = createClient(opts(f));
  await c.getDispute('d1');
  await c.getDispute('d1');
  assert.equal(c.logins, 1);
  assert.equal(f.calls[0].host, 'api.sandbox.airwallex.com');
  assert.deepEqual(f.calls[0].headers, { 'x-client-id': 'cid', 'x-api-key': 'key' });
  assert.equal(f.calls[1].headers.authorization, 'Bearer tok');
});

test('re-logs in a minute before expiry and on credentials_expired', async () => {
  let t = Date.parse('2026-10-25T00:00:00Z');
  let n = 0;
  const f = fake({
    'POST /api/v1/authentication/login': login(),
    'GET /api/v1/pa/payment_disputes/d1': () => (++n === 2 ? [401, { code: 'credentials_expired' }] : [200, { id: 'd1' }]),
  });
  const c = createClient({ ...opts(f), now: () => t });
  await c.getDispute('d1');
  await c.getDispute('d1'); // 401 -> login -> retry
  assert.equal(c.logins, 2);
  t = Date.parse('2026-10-25T00:29:30Z'); // inside the 60s skew
  await c.getDispute('d1');
  assert.equal(c.logins, 3);
});

test('backs off on 429 using retry-after, then gives up with a typed error', async () => {
  const waits = [];
  const f = fake({
    'POST /api/v1/authentication/login': login(),
    'GET /api/v1/pa/payment_disputes/d1': () => [429, { code: 'too_many_requests' }, { 'retry-after': '3' }],
  });
  const c = createClient({ ...opts(f), wait: async (ms) => waits.push(ms) });
  await assert.rejects(c.getDispute('d1'), (e) => e instanceof AirwallexError && e.status === 429);
  assert.deepEqual(waits, [3000, 3000]);
});

test('bad credentials fail at login, not later', async () => {
  const f = fake({ 'POST /api/v1/authentication/login': () => [401, { code: 'credentials_invalid' }] });
  await assert.rejects(createClient(opts(f)).getDispute('d1'), /login: HTTP 401 credentials_invalid/);
});

test('listDisputes follows page_after and passes filters', async () => {
  const pages = { undefined: { items: [{ id: 'a' }, { id: 'b' }], page_after: 'Yg==' }, 'Yg==': { items: [{ id: 'c' }], page_after: 'Yw==' },
    'Yw==': { items: [], page_after: null } };
  const f = fake({
    'POST /api/v1/authentication/login': login(),
    'GET /api/v1/pa/payment_disputes': (call) => [200, pages[call.query.page]],
  });
  const items = await createClient(opts(f)).listDisputes({ status: 'REQUIRES_RESPONSE' }, { size: 2 });
  assert.deepEqual(items.map((d) => d.id), ['a', 'b', 'c']);
  const lists = f.calls.filter((c) => c.method === 'GET');
  assert.equal(lists[0].query.status, 'REQUIRES_RESPONSE');
  assert.equal(lists[0].query.size, '2');
  assert.equal(lists[0].query.page, undefined);
  assert.equal(lists[1].query.page, 'Yg==');
});

test('uploadFile goes to the files host as multipart with names clipped to 50', async () => {
  const f = fake({
    'POST /api/v1/authentication/login': login(),
    'POST /api/v1/files/upload': () => [201, { file_id: 'f1' }],
  });
  const r = await createClient(opts(f)).uploadFile(`${'x'.repeat(60)}.png`, new Uint8Array([1, 2, 3]), 'n'.repeat(70));
  assert.equal(r.file_id, 'f1');
  const up = f.calls.find((c) => c.path === '/api/v1/files/upload');
  assert.equal(up.host, 'files.sandbox.airwallex.com');
  assert.ok(up.body instanceof FormData);
  assert.equal(up.body.get('file').name.length, 50);
  assert.equal(up.body.get('notes').length, 50);
  await assert.rejects(createClient(opts(f)).uploadFile('big.png', { length: 21 * 1024 * 1024 }), /20MB/);
});

const BODY = { request_id: 'r1', challenge_method: 'STANDARD', challenge_details: { reason: 'PRODUCT_RECEIVED', stage: 'CHARGEBACK',
  evidence: { order_fulfillment_file_ids: ['doc_scan'], customer_communication_file_ids: ['doc_mail', 'doc_scan'],
    merchant_business_model_description: 'Tea.' } } };

test('swapFileIds expands multi-page docs in order and refuses a missing upload', () => {
  const out = swapFileIds(BODY, { doc_scan: ['f1', 'f2'], doc_mail: ['f3'] });
  assert.deepEqual(out.challenge_details.evidence.order_fulfillment_file_ids, ['f1', 'f2']);
  assert.deepEqual(out.challenge_details.evidence.customer_communication_file_ids, ['f3', 'f1', 'f2']);
  assert.equal(out.challenge_details.evidence.merchant_business_model_description, 'Tea.');
  assert.deepEqual(BODY.challenge_details.evidence.order_fulfillment_file_ids, ['doc_scan']); // not mutated
  assert.throws(() => swapFileIds(BODY, { doc_scan: ['f1'] }), /doc_mail was not uploaded/);
});

test('submitChallenge uploads every page, then posts the swapped body', async () => {
  let n = 0;
  const f = fake({
    'POST /api/v1/authentication/login': login(),
    'POST /api/v1/files/upload': () => [201, { file_id: `f${++n}` }],
    'POST /api/v1/pa/payment_disputes/d1/challenge': (call) => [200, { id: 'd1', status: 'CHALLENGED', echo: JSON.parse(call.body) }],
  });
  const png = (name) => ({ name, bytes: new Uint8Array([0]) });
  const r = await submitChallenge(createClient(opts(f)), 'd1', BODY,
    { doc_scan: [png('doc_scan_p1.png'), png('doc_scan_p2.png')], doc_mail: [png('doc_mail.png')] });
  assert.deepEqual(r.uploaded, { doc_scan: ['f1', 'f2'], doc_mail: ['f3'] });
  assert.equal(r.reply.status, 'CHALLENGED');
  assert.deepEqual(r.reply.echo.challenge_details.evidence.order_fulfillment_file_ids, ['f1', 'f2']);
  const post = f.calls.at(-1);
  assert.equal(post.headers['content-type'], 'application/json');
  assert.equal(f.calls.filter((c) => c.path === '/api/v1/files/upload').length, 3);
});

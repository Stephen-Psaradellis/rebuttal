// Rebuttal - the evidence gatherer (lanes.md B4, step 2 of the concept).
//
// Turns what the merchant already has (orders, shipments, logins, emails,
// policy, past disputes) into Airwallex evidence fields. It never invents a
// fact: a field is filled only from a record that exists, and every record it
// uses becomes a document the merchant can read. A parcel with no delivery
// scan is NOT proof of delivery, so it fills nothing and says why.
//
// Documents carry local ids (doc_*). The sandbox client swaps them for File
// Service ids after rendering each one to an image (evidence files must be
// JPG/PNG/WEBP), so the decision can run before anything is uploaded.

const DAY = 864e5;
const t = (s) => Date.parse(s);
const money = (n, cur) => `${Number(n).toFixed(2)} ${cur}`;

export function findOrder(store, dispute) {
  return store.orders.find((o) => o.payment_intent_id === dispute.payment_intent_id) || null;
}

const itemsText = (store, order) => order.items.map((sku) => store.products[sku]?.title || sku).join(', ');

// gather(dispute, store, history) -> { order, evidence, documents, notes }
// `history` is every other dispute the merchant has seen (for wins on the same card).
export function gather(dispute, store, history = []) {
  const evidence = {};
  const documents = [];
  const notes = [];
  const add = (field, title, lines, value) => {
    const id = `doc_${dispute.id}_${field.replace(/_file_ids$/, '')}`;
    documents.push({ id, field, title, lines });
    evidence[field] = [id];
    if (value !== undefined) notes.push(value);
  };

  const order = findOrder(store, dispute);
  if (!order) {
    notes.push(`no store order matches payment ${dispute.payment_intent_id}`);
    return { order: null, evidence, documents, notes };
  }
  const cust = store.customers.find((c) => c.id === order.customer) || {};
  const created = t(order.created_at);

  // Always available once the order is found.
  add('order_snapshot_file_ids', `Order ${order.id} receipt`, [
    `Order ${order.id}, placed ${order.created_at}`,
    `Customer: ${cust.name || '?'} <${cust.email || '?'}>${cust.account ? ' (account holder)' : ' (guest checkout)'}`,
    `Items: ${itemsText(store, order)}`,
    `Total: ${money(order.total, order.currency)}`,
    `Ship to: ${order.ship_to}`,
    `Placed from IP ${order.ip}, ${order.device}`,
  ], `order ${order.id} found`);
  const products = order.items.map((sku) => store.products[sku]).filter(Boolean);
  if (products.length) {
    evidence.product_description = products.map((p) => `${p.title}: ${p.description}`).join(' | ');
    add('product_snapshot_file_ids', `Product listing${products.length > 1 ? 's' : ''} as sold`,
      products.map((p) => `${p.title} - ${money(p.price, order.currency)} - ${p.description}`));
  }
  if (store.store?.business_model) evidence.merchant_business_model_description = store.store.business_model;
  if (store.store?.refund_policy_url) evidence.refund_policy_url = store.store.refund_policy_url;
  if (store.store?.refund_policy) {
    add('refund_policy_file_ids', 'Refund and cancellation policy', [store.store.refund_policy, store.store.refund_policy_url || '']);
  }
  if (store.store?.terms_text) {
    add('user_agreement_file_ids', `Terms accepted at checkout (version ${store.store.terms_version || '?'})`, [store.store.terms_text]);
  }

  // Delivery: only a delivery scan counts.
  const sh = order.shipment;
  if (sh?.delivered_at) {
    evidence.order_fulfilled_at = sh.delivered_at.slice(0, 10);
    add('order_fulfillment_file_ids', `Delivery proof, ${sh.carrier} ${sh.tracking}`, [
      `Shipped ${sh.shipped_at}, delivered ${sh.delivered_at}`,
      `Carrier note: ${sh.proof || 'delivered'}`,
      `Order ship-to: ${order.ship_to}`,
    ], `delivered ${sh.delivered_at.slice(0, 10)} (${sh.carrier})`);
  } else if (sh?.shipped_at) {
    notes.push(`shipped ${sh.shipped_at.slice(0, 10)} (${sh.carrier} ${sh.tracking}) but no delivery scan - not proof of delivery`);
  } else {
    notes.push('never shipped');
  }

  // What the customer said to us, from the day before the order on.
  const mail = store.emails.filter((e) => e.customer === order.customer && t(e.at) >= created - DAY);
  if (mail.length) {
    add('customer_communication_file_ids', `Emails with ${cust.name || order.customer}`,
      mail.map((e) => `${e.at} ${e.from}: "${e.subject}" - ${e.body}`), `${mail.length} email(s) with the customer`);
  }

  // Account activity from the same IP or device as the order (account holders only).
  if (cust.account) {
    const acts = store.logins.filter((l) => l.customer === order.customer && t(l.at) >= created - 7 * DAY
      && (l.ip === order.ip || l.device === order.device));
    if (acts.length) {
      add('access_activity_file_ids', `Account activity matching the order's IP/device`,
        acts.map((l) => `${l.at} ${l.ip} ${l.device}${l.event ? ` - ${l.event}` : ' - signed in'}`),
        `${acts.length} account event(s) from the order's IP/device`);
    }
  } else {
    notes.push('guest checkout: no account activity to show');
  }

  // Earlier delivered, undisputed orders on the same card to the same address.
  const disputedPis = new Set(history.filter((d) => d.id !== dispute.id && d.status !== 'WON').map((d) => d.payment_intent_id));
  const sameCard = (o) => store.customers.find((c) => c.id === o.customer)?.card_fingerprint === cust.card_fingerprint;
  const prior = store.orders.filter((o) => o.id !== order.id && sameCard(o) && t(o.created_at) < created
    && o.ship_to === order.ship_to && o.shipment?.delivered_at && !disputedPis.has(o.payment_intent_id));
  if (prior.length) {
    add('previous_purchase_similar_product_file_ids', `${prior.length} earlier undisputed order(s), same card and address`,
      prior.map((o) => `${o.id} ${o.created_at.slice(0, 10)} ${itemsText(store, o)} ${money(o.total, o.currency)} - delivered ${o.shipment.delivered_at.slice(0, 10)}, IP ${o.ip}`),
      `${prior.length} earlier undisputed order(s) on the same card`);
  }
  const wins = history.filter((d) => d.id !== dispute.id && d.status === 'WON').map((d) => ({ d, o: findOrder(store, d) }))
    .filter(({ o }) => o && sameCard(o));
  if (wins.length) {
    add('previous_dispute_won_on_same_card_file_ids', 'Earlier disputes on this card that the merchant won',
      wins.map(({ d, o }) => `${d.id} on ${o.id}: ${d.reason?.type}, ${money(d.amount, d.currency)}, WON`),
      `${wins.length} earlier dispute(s) won on this card`);
  }

  // Duplicate-charge claims: another order, same customer and amount, within 48h.
  if (['DUPLICATE_CHARGE', 'PROCESSING_ERRORS'].includes(dispute.reason?.type)) {
    const twin = store.orders.find((o) => o.id !== order.id && o.customer === order.customer
      && o.total === order.total && Math.abs(t(o.created_at) - created) <= 2 * DAY);
    if (!twin) {
      notes.push('no second charge of the same amount found');
    } else if ([...twin.items].sort().join() === [...order.items].sort().join()) {
      notes.push(`${twin.id} has the same items - this looks like a real duplicate`);
    } else {
      evidence.duplicate_explanation = `Two separate orders, not one order charged twice: ${twin.id} (${itemsText(store, twin)}) `
        + `and ${order.id} (${itemsText(store, order)}), placed ${twin.created_at} and ${order.created_at}, each shipped and delivered separately.`;
      evidence.duplicate_transaction_created_at = twin.created_at;
      add('duplicate_payment_file_ids', `The other order: ${twin.id}`, [
        `${twin.id} placed ${twin.created_at}: ${itemsText(store, twin)}, ${money(twin.total, twin.currency)}`,
        `Tracking ${twin.shipment?.carrier} ${twin.shipment?.tracking}, delivered ${twin.shipment?.delivered_at || 'n/a'}`,
      ], `${twin.id} is a separate order with different items`);
    }
  }

  return { order, evidence, documents, notes };
}

// Only the fields the decision relies on go into the challenge, plus the
// business description, so a reviewer is not handed the whole file.
export function packFor(decision, evidence) {
  const keep = new Set([...(decision.fields || []), 'merchant_business_model_description']);
  return Object.fromEntries(Object.entries(evidence).filter(([k]) => keep.has(k)));
}

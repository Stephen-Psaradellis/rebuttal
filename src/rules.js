// Rebuttal - the dispute contract, written before the build (lanes.md B4.3).
//
// Field names and enums are Airwallex's own, read 2026-10-14 from
// https://www.airwallex.com/docs/api/payments/payment_disputes :
//   GET  /api/v1/pa/payment_disputes/{id}          dispute object
//   POST /api/v1/pa/payment_disputes/{id}/accept   ACCEPT_BODY below
//   POST /api/v1/pa/payment_disputes/{id}/challenge challenge body below
// Airwallex publishes no reason-type -> evidence table, so REASON_RULES is
// ours: the card networks' usual compelling evidence for each dispute family,
// mapped onto Airwallex's evidence field names. Evidence files must be
// JPG/PNG/WEBP up to 10MB (File Service), so every document we attach is
// rendered to an image first.

export const STAGES = ['RFI', 'PRE_CHARGEBACK', 'CHARGEBACK', 'PRE_ARBITRATION', 'ARBITRATION'];
// The challenge endpoint only takes these stages; later ones go to a human.
export const CHALLENGE_STAGES = ['RFI', 'PRE_CHARGEBACK', 'CHARGEBACK'];

export const STATUSES = ['REQUIRES_RESPONSE', 'CHALLENGED', 'ACCEPTED', 'REVERSED', 'WON', 'LOST',
  'PENDING_CLOSURE', 'EXPIRED', 'PENDING_DECISION'];

export const REASON_TYPES = ['CREDIT_NOT_PROCESSED', 'FRAUDULENT', 'DUPLICATE_CHARGE',
  'PRODUCT_NOT_RECEIVED', 'PRODUCT_UNACCEPTABLE', 'UNRECOGNIZED_CHARGE', 'CANCELLED_PRODUCT',
  'MISREPRESENTATION', 'COUNTERFEIT_PRODUCT', 'PROCESSING_ERRORS', 'AUTHORIZATION', 'NOT_RECOGNIZED',
  'BANK_REJECTION', 'FUND_REVERSAL', 'CONSUMER_DISPUTE', 'POINT_OF_INTERACTION_ERROR', 'UNKNOWN'];

export const CHALLENGE_REASONS = ['CUSTOMER_WITHDRAWN', 'CUSTOMER_REFUNDED', 'PRODUCT_RECEIVED',
  'PURCHASE_HISTORY', 'NOT_ENTITLED', 'SEPARATE_PRODUCT', 'AUTHENTIC_PRODUCT', 'OTHER_REASONS'];

// Request-side accept reasons (the response enum has more, set by Airwallex).
export const ACCEPT_REASONS = ['AGREEMENT_REACHED_WITH_CUSTOMER', 'CUSTOMER_RELATIONSHIP_MAINTENANCE',
  'LOW_VALUE_TRANSACTION', 'VALID_CUSTOMER_DISPUTE', 'COLLABORATION_ACCEPTED_MANUAL', 'OTHERS'];
export const REFUND_REASONS = ['REQUESTED_BY_CUSTOMER', 'DUPLICATE', 'FRAUDULENT', 'ABANDONED', 'OTHERS'];

export const FILE_FIELDS = ['access_activity_file_ids', 'authenticity_proof_file_ids',
  'customer_communication_file_ids', 'duplicate_payment_file_ids', 'order_fulfillment_file_ids',
  'order_snapshot_file_ids', 'previous_dispute_won_on_same_card_file_ids',
  'previous_purchase_similar_product_file_ids', 'product_consumption_file_ids',
  'product_snapshot_file_ids', 'refund_policy_file_ids', 'user_agreement_file_ids'];
export const TEXT_FIELDS = ['duplicate_acquirer_reference_number', 'duplicate_explanation',
  'duplicate_transaction_amount_currency', 'duplicate_transaction_created_at',
  'merchant_business_model_description', 'order_fulfilled_at', 'product_description',
  'refund_policy_url'];
export const EVIDENCE_FIELDS = [...FILE_FIELDS, ...TEXT_FIELDS];

// A requirement is a field name, or an array meaning "any one of these".
// `required` must all be met to challenge; `supporting` only strengthens the pack.
const FRAUD_FAMILY = {
  reasons: ['PURCHASE_HISTORY', 'PRODUCT_RECEIVED'],
  required: ['order_snapshot_file_ids',
    ['access_activity_file_ids', 'previous_purchase_similar_product_file_ids',
      'previous_dispute_won_on_same_card_file_ids']],
  supporting: ['order_fulfillment_file_ids', 'product_consumption_file_ids',
    'customer_communication_file_ids'],
};
const DUPLICATE_FAMILY = {
  reasons: ['SEPARATE_PRODUCT'],
  required: ['duplicate_explanation', 'order_snapshot_file_ids'],
  supporting: ['duplicate_payment_file_ids', 'duplicate_acquirer_reference_number',
    'duplicate_transaction_amount_currency', 'duplicate_transaction_created_at'],
};
const CREDIT_FAMILY = {
  reasons: ['NOT_ENTITLED'],
  required: [['refund_policy_file_ids', 'refund_policy_url'], 'customer_communication_file_ids'],
  supporting: ['user_agreement_file_ids', 'order_snapshot_file_ids', 'product_consumption_file_ids'],
};
const QUALITY_FAMILY = {
  reasons: ['NOT_ENTITLED', 'PRODUCT_RECEIVED'],
  required: ['product_description', ['product_snapshot_file_ids', 'order_snapshot_file_ids']],
  supporting: ['refund_policy_file_ids', 'customer_communication_file_ids',
    'product_consumption_file_ids'],
};

export const REASON_RULES = {
  PRODUCT_NOT_RECEIVED: {
    reasons: ['PRODUCT_RECEIVED'],
    required: ['order_fulfillment_file_ids', 'order_fulfilled_at'],
    supporting: ['order_snapshot_file_ids', 'customer_communication_file_ids',
      'product_consumption_file_ids'],
  },
  FRAUDULENT: FRAUD_FAMILY,
  UNRECOGNIZED_CHARGE: FRAUD_FAMILY,
  NOT_RECOGNIZED: FRAUD_FAMILY,
  DUPLICATE_CHARGE: DUPLICATE_FAMILY,
  PROCESSING_ERRORS: DUPLICATE_FAMILY,
  CREDIT_NOT_PROCESSED: CREDIT_FAMILY,
  CANCELLED_PRODUCT: CREDIT_FAMILY,
  PRODUCT_UNACCEPTABLE: QUALITY_FAMILY,
  MISREPRESENTATION: QUALITY_FAMILY,
  COUNTERFEIT_PRODUCT: {
    reasons: ['AUTHENTIC_PRODUCT'],
    required: ['authenticity_proof_file_ids'],
    supporting: ['product_snapshot_file_ids', 'product_description'],
  },
  CONSUMER_DISPUTE: {
    reasons: ['OTHER_REASONS'],
    required: ['customer_communication_file_ids', 'order_snapshot_file_ids'],
    supporting: ['refund_policy_file_ids', 'user_agreement_file_ids'],
  },
  // AUTHORIZATION, BANK_REJECTION, FUND_REVERSAL, POINT_OF_INTERACTION_ERROR and
  // UNKNOWN have no rule on purpose: they turn on the acquirer's records, not the
  // merchant's, so the agent escalates them instead of guessing.
};

export const DEFAULT_POLICY = {
  autoAcceptMax: 50,       // never accept above this without a human
  minChallengeAmount: 15,  // below this, fighting costs more than it can win
  urgentHours: 48,         // a case this close to due_at is flagged urgent
};

const present = (evidence, field) => {
  const v = evidence?.[field];
  if (FILE_FIELDS.includes(field)) return Array.isArray(v) && v.length > 0;
  return typeof v === 'string' && v.trim() !== '';
};
const met = (evidence, req) => (Array.isArray(req) ? req.some((f) => present(evidence, f)) : present(evidence, req));

// Which required items are missing for this reason type (each as a field or an any-of list).
export function missingEvidence(reasonType, evidence) {
  const rule = REASON_RULES[reasonType];
  if (!rule) return null;
  return rule.required.filter((req) => !met(evidence, req));
}

export function refundedTotal(dispute) {
  return (dispute.refunds || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
}

// The one decision. Returns {action, ...} where action is NONE | ACCEPT | CHALLENGE | ESCALATE,
// always with a plain `why` the audit trail shows the merchant.
export function decide(dispute, evidence = {}, policy = DEFAULT_POLICY, now = new Date()) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const amount = Number(dispute.amount) || 0;
  const hoursLeft = dispute.due_at ? (Date.parse(dispute.due_at) - now.getTime()) / 3.6e6 : null;
  const urgent = dispute.status === 'REQUIRES_RESPONSE' && hoursLeft !== null && hoursLeft > 0
    && hoursLeft <= p.urgentHours;
  const out = (action, why, extra = {}) => ({ action, why, urgent, hoursLeft, ...extra });

  if (dispute.status !== 'REQUIRES_RESPONSE') return out('NONE', `status is ${dispute.status}; nothing to answer`);
  if (hoursLeft !== null && hoursLeft <= 0) return out('NONE', 'past due_at; the window has closed');
  if (!CHALLENGE_STAGES.includes(dispute.stage)) {
    return out('ESCALATE', `${dispute.stage} cannot be challenged through the API`);
  }

  const reasonType = dispute.reason?.type || 'UNKNOWN';
  if (amount > 0 && refundedTotal(dispute) >= amount) {
    return out('CHALLENGE', 'the customer was already refunded in full', {
      reason: 'CUSTOMER_REFUNDED', fields: [] });
  }

  const rule = REASON_RULES[reasonType];
  if (!rule) return out('ESCALATE', `no evidence rule for ${reasonType}; a human reads it`);

  const missing = missingEvidence(reasonType, evidence);
  const acceptable = amount <= p.autoAcceptMax;
  if (missing.length) {
    const names = missing.map((m) => (Array.isArray(m) ? m.join(' or ') : m)).join('; ');
    if (acceptable) {
      return out('ACCEPT', `missing required evidence (${names}) and ${amount} is within the auto-accept limit`, {
        reason: 'VALID_CUSTOMER_DISPUTE', missing });
    }
    return out('ESCALATE', `missing required evidence (${names}) and ${amount} is above the auto-accept limit`, { missing });
  }
  if (amount < p.minChallengeAmount && acceptable) {
    return out('ACCEPT', `${amount} is below the cost of fighting (${p.minChallengeAmount})`, {
      reason: 'LOW_VALUE_TRANSACTION' });
  }
  const fields = [...rule.required.flat(), ...rule.supporting].filter((f) => present(evidence, f));
  return out('CHALLENGE', `${reasonType}: every required item is on file`, {
    reason: rule.reasons[0], fields: [...new Set(fields)] });
}

// Build and check the POST bodies. Throws on anything Airwallex would reject.
// The API refuses a CHARGEBACK challenge without one of these
// ("Valid product_type must be provided", measured 2026-10-31).
export const PRODUCT_TYPES = ['PHYSICAL_GOODS', 'DIGITAL_PRODUCT_OR_SERVICE', 'OFFLINE_SERVICE', 'TRAVEL',
  'RESERVE_OR_BOOKING', 'OTHERS'];

export function challengeBody(dispute, decision, evidence, requestId, productType) {
  if (decision.action !== 'CHALLENGE') throw new Error('not a challenge decision');
  if (productType !== undefined && !PRODUCT_TYPES.includes(productType)) throw new Error(`bad product_type ${productType}`);
  if (dispute.stage === 'CHARGEBACK' && !productType) throw new Error('product_type is required at CHARGEBACK');
  if (!CHALLENGE_REASONS.includes(decision.reason)) throw new Error(`bad challenge reason ${decision.reason}`);
  if (!CHALLENGE_STAGES.includes(dispute.stage)) throw new Error(`stage ${dispute.stage} cannot be challenged`);
  if (!requestId) throw new Error('request_id is required');
  const ev = {};
  for (const [k, v] of Object.entries(evidence || {})) {
    if (!EVIDENCE_FIELDS.includes(k)) throw new Error(`unknown evidence field ${k}`);
    if (FILE_FIELDS.includes(k) && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) {
      throw new Error(`${k} must be an array of file ids`);
    }
    if (TEXT_FIELDS.includes(k) && typeof v !== 'string') throw new Error(`${k} must be a string`);
    if (present(evidence, k)) ev[k] = v;
  }
  return { request_id: requestId, challenge_method: 'STANDARD',
    challenge_details: { reason: decision.reason, stage: dispute.stage,
      ...(productType ? { product_type: productType } : {}), evidence: ev } };
}

export function acceptBody(dispute, decision, requestId, acceptedBy = 'rebuttal-agent') {
  if (decision.action !== 'ACCEPT') throw new Error('not an accept decision');
  if (!requestId) throw new Error('request_id is required');
  const reason = ACCEPT_REASONS.includes(decision.reason) ? decision.reason : 'OTHERS';
  const body = { request_id: requestId, accepted_by: acceptedBy, reason, description: decision.why };
  // At RFI an accept refunds; say so explicitly rather than lean on the default.
  if (dispute.stage === 'RFI') {
    body.refund = { amount: Number(dispute.amount) - refundedTotal(dispute), reason: 'REQUESTED_BY_CUSTOMER' };
  }
  return body;
}

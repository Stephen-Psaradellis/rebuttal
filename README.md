# Rebuttal - a chargeback desk for small merchants

An agent for Airwallex's Dispute Response track: when a chargeback lands, it
pulls the dispute, gathers the evidence the merchant already has, and decides
**accept**, **challenge** or **escalate** - with a written reason for every step.

Small merchants lose disputes by default: the evidence is spread over five tools
and the response window is short. Rebuttal's value is the decision and the
deadline, not the letter.

## What works today

- `src/rules.js` - the decision contract, on Airwallex's own enums and evidence
  field names (`/api/v1/pa/payment_disputes`). Hard rules: it never challenges
  without the evidence the reason code needs, never accepts above a
  merchant-set amount without a person, and escalates pre-arbitration and
  bank-side reason codes instead of guessing.
- `src/evidence.js` - the evidence gatherer. It fills a field only from a record
  that exists (orders, delivery scans, account activity, emails, earlier
  purchases and won disputes on the same card, the refund policy). A parcel with
  no delivery scan is *not* proof of delivery, so it fills nothing and says why.
- `src/run.js` - one pass over the open disputes with an audit trail. Each
  POST body is built and validated, then **not sent** (dry run) until the
  sandbox client lands.
- `src/render.js` - evidence documents to images. Airwallex takes evidence
  files as JPG/PNG/WEBP up to 10MB, so each document becomes a plain page
  (dispute, field, the record's own lines, where they came from) rendered to
  PNG with resvg; long ones split into pages rather than shrink. Only the
  documents the challenge actually names are rendered.

```
npm install && npm test                    # 25 tests
node src/run.js --now 2026-10-25T00:00:00Z # the demo pass
node src/run.js --now 2026-10-25T00:00:00Z --render out  # + 14 evidence PNGs
```

Demo output, 10 disputes against a fictional tea shop: 5 challenged, 2
accepted (a $12 case below the cost of fighting; a lost parcel with no delivery
scan), 2 escalated (a guest-checkout fraud claim above the auto-accept limit; a
pre-arbitration case), 1 already closed.

## Next

Airwallex sandbox client (list/get disputes, simulated disputes, File Service
uploads of the rendered PNGs), then a hosted case board with
a live trace of every step.

## Data

`fixtures/` is invented: the store, customers, emails and addresses are
fictional, and IPs come from the documentation ranges.

## AI use

Built with AI coding assistance (Claude). MIT licence.

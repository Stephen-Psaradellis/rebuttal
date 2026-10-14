# Rebuttal - a chargeback desk for small merchants

An agent for Airwallex's Dispute Response track: when a chargeback lands, it
pulls the dispute, gathers the evidence the merchant already has, and decides
**accept**, **challenge** or **escalate** - with a written reason for every step.

Small merchants lose disputes by default: the evidence is spread over five tools
and the response window is short. Rebuttal's value is the decision and the
deadline; the letter is written last, and only from what was found.

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
  POST body is built and validated, then **not sent** (dry run) until it runs
  with sandbox keys.
- `src/render.js` - evidence documents to images. Airwallex takes evidence
  files as JPG/PNG/WEBP up to 10MB, so each document becomes a plain page
  (dispute, field, the record's own lines, where they came from) rendered to
  PNG with resvg; long ones split into pages rather than shrink. Only the
  documents the challenge actually names are rendered.
- `src/client.js` - the Airwallex client: login with a 30-minute token reused
  until it expires, dispute list (follows `page_after`) and get, File Service
  upload to the `files.` host, challenge and accept. Re-logs in on
  `credentials_expired`, backs off on 429. `submitChallenge` uploads every
  rendered page, swaps our document ids for File Service ids (a multi-page
  document becomes several files, in order) and refuses to post a challenge
  that points at a document it did not upload. Tested against a fake Airwallex;
  sandbox keys come with the hackathon account.
- `src/letter.js` - the rebuttal letter, the one place a model writes. Each
  challenge gets a one-page cover letter to the issuer's reviewer, attached as
  page 1 of the order snapshot. Before a model letter is used, every number,
  date, id, tracking code, email and IP in it must appear in the attached
  records, and it may not claim a delivery, a sign-in or an earlier win that no
  document shows. A letter that fails goes in the bin and a template letter
  built from the same records goes instead; the trail says which and why. Any
  OpenAI-compatible endpoint works (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`);
  with none set, every letter is the template.

```
npm install && npm test                    # 44 tests
node src/run.js --now 2026-10-25T00:00:00Z # the demo pass
node src/run.js --now 2026-10-25T00:00:00Z --render out  # + 14 evidence PNGs
node src/board.js --now 2026-10-25T00:00:00Z --out docs  # the case board
```

Demo output, 10 disputes against a fictional tea shop: 5 challenged, 2
accepted (a $12 case below the cost of fighting; a lost parcel with no delivery
scan), 2 escalated (a guest-checkout fraud claim above the auto-accept limit; a
pre-arbitration case), 1 already closed.

Case board (static, from the demo pass): https://stephen-psaradellis.github.io/rebuttal/ -
cases that need the merchant first, then by deadline; each card shows the
decision and why, the evidence fields it would send with the rendered pages,
what is missing, the rebuttal letter, the audit trail and the request body
(`src/board.js`). The published board's letters were written by Gemma 4 E4B
running locally (Ollama); all 5 passed the fact check on this run. In an
earlier run one letter failed it and went out as the template instead.

## Next

Run the client against the sandbox (simulated disputes) and serve the board
from it, with a live trace of every step.

## Data

`fixtures/` is invented: the store, customers, emails and addresses are
fictional, and IPs come from the documentation ranges.

## AI use

Built with AI coding assistance (Claude). The rebuttal letters on the demo board
are model-written (Gemma 4 E4B) and fact-checked as above. MIT licence.

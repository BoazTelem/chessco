# Refund Policy — DRAFT

> Spec refs: §11, §20. DRAFT — lawyer review required.

**Effective date:** {EFFECTIVE_DATE}

This policy describes how Chessco handles refund requests for paid sparring matches. Subscriptions are governed by a separate cancellation policy in Section 5.

## 1. Valid refund reasons

You may file a refund for a paid match only under one of these categorical reasons:

- **opponent_abandoned** — your opponent disconnected and did not return within the 60-second grace period.
- **opponent_didnt_play_position** — the match started from a position different from the one in the published challenge.
- **engine_assistance_suspected** — you believe your opponent used an engine. (Triggers a fairplay review, not an immediate refund.)
- **harassment** — your opponent harassed you during the match. (Triggers a moderation review.)
- **technical_failure** — Chessco's platform failed in a way that disrupted the match (server crash, clock desync, etc.).
- **other** — anything else. Required to include free-text detail.

## 2. Auto-resolution (within 60 seconds)

Two reasons auto-resolve when the server can confirm them:

- `opponent_abandoned` is auto-approved when the match status is `abandoned` with `abandonedBy = opponent`. The fee returns to your wallet from escrow.
- `opponent_didnt_play_position` is auto-approved when the first FEN observed by our realtime server differs from the FEN in the published challenge.

Other reasons are routed to manual review.

## 3. Manual review SLA

- `engine_assistance_suspected`: 24–72 hours (depends on Stockfish re-analysis queue).
- `harassment`: up to 48 hours.
- `technical_failure`: up to 48 hours.
- `other`: up to 72 hours.

You will receive an email when your refund is decided.

## 4. Filing limits

Filing 3 refund requests in the last 90 days that are denied (status = `denied`) results in a 30-day filing suspension. Auto-approved refunds and approved manual reviews do not count toward this limit.

## 5. Subscription cancellations

Subscriptions can be cancelled at any time from `/account/wallet`. Cancellation stops future billing. Pro-rata refunds for the current billing period are not provided.

## 6. Chargebacks

Initiating a chargeback with your bank or card provider freezes your account pending resolution. Repeated chargebacks for legitimately rendered services may result in account termination.

## 7. How refunds reach you

Refunds are credited to your Chessco wallet in the original currency. Withdrawals are subject to the hold period for your trust tier per Section 8 of the Terms.

## 8. Contact

{SUPPORT_EMAIL} for questions about a specific refund. Reference the match ID in your email.

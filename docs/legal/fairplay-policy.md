# Fairplay Policy — DRAFT

> Spec refs: §12, §20. DRAFT — lawyer review required.

**Effective date:** {EFFECTIVE_DATE}

Chessco is a real-chess platform. The integrity of every game — practice or paid — is non-negotiable. This policy describes what we monitor for, how decisions are made, and how to appeal.

## 1. Prohibited conduct

- **Engine assistance**: using a chess engine, neural network, or any other software/human aid to influence your moves during a live Chessco game.
- **Sandbagging**: deliberately losing or playing below your strength to manipulate your rating or trust tier.
- **Account farming**: creating multiple accounts to manipulate the marketplace (collusion, transfer of value, evading suspensions).
- **Result fixing**: pre-arranging outcomes with an opponent.
- **Harassment**: chat or behavior intended to intimidate, demean, or threaten.

Match cancellation, draw offers, and resignations made in good faith are NOT violations.

## 2. How we detect

- **Engine correlation** — we re-analyze completed games at multiple Stockfish depths and compare the move-match rate against your rating band's expected baseline.
- **Move-time vs. complexity** — anomalously fast moves in critical positions, or anomalously slow moves in obvious recaptures, are flagged.
- **Passive telemetry** — during live games we record signals like tab focus changes, mouse idle, paste events, and devtools usage. We do not record screen contents, keystrokes outside the chat, or anything from other tabs.
- **Player reports** — you can report an opponent during or after a match.
- **External rating cross-check** — a Chessco rating that diverges sharply from a verified external rating triggers sandbagging review.

## 3. Severity ladder

| Severity | Outcome                                    |
| -------- | ------------------------------------------ |
| 1        | Warning, logged. No restriction.           |
| 2        | Paid-play suspended for 7 days.            |
| 3        | Paid-play suspended for 30 days.           |
| 4        | Paid-play permanently suspended.           |
| 5        | Full account suspended for 30 days.        |
| 6        | Permanent ban; pending earnings forfeited. |

A single confirmed engine-assistance flag in a paid match typically lands at severity 4 or higher.

## 4. Decisions

Decisions are made by a human reviewer within 72 hours of a flag entering the queue. Reviewers consider engine correlation, telemetry, move-time, history, and the player's own report if any.

## 5. Appeals

If you believe an action against your account was in error, you may appeal once per action via `/account/fairplay/appeal/{action_id}` or by emailing {APPEALS_EMAIL}. Appeals are reviewed by a senior reviewer not involved in the original decision. SLA: 5 business days.

## 6. KYC for high earnings

We require KYC verification once your cumulative paid earnings reach $20 (configurable). Earnings without KYC are capped at $50. KYC is mediated by our payment provider; we receive only an approved/rejected flag.

## 7. Transparency

We publish an annual transparency report covering actions taken by severity, false-positive rate on the labeled eval set, and notable appeal outcomes.

## 8. Contact

{FAIRPLAY_EMAIL} for fairplay questions. {APPEALS_EMAIL} for appeals.

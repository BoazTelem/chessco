# Privacy Policy — DRAFT

> Spec refs: §20, §24. DRAFT — lawyer review required.

**Effective date:** {EFFECTIVE_DATE}
**Controller:** {COMPANY_LEGAL_NAME}, {REGISTERED_ADDRESS}. EU representative: {EU_REP}. UK representative: {UK_REP}.

## What we collect

- **Account data**: email, display name, country (optional), date of birth (for 18+ paid-feature gating), language preference.
- **Linked accounts**: chess.com / Lichess handles and OAuth tokens (encrypted at rest).
- **Game data**: PGNs you upload, games we fetch from your linked accounts, derived per-position aggregates, engine evaluation results.
- **Marketplace activity**: challenges you create or accept, matches played, wallet balance, ledger entries.
- **Communications**: support emails you send us.
- **Technical**: IP, user-agent, timestamps; minimal logs for security + abuse prevention.

We do not collect: precise location, biometric data, government IDs (KYC is provider-mediated and we receive only an approved/rejected flag).

## How we use it

- Operate the service: matching, prep reports, payments, comms.
- Protect the marketplace: fraud detection, fairplay analysis, anti-abuse.
- Improve the product: aggregate analytics, A/B testing. Individual game-level data is **not** used for AI model training without your explicit opt-in.
- Comply with law: tax records, payment regulator inquiries, lawful requests.

## Legal bases (GDPR Art. 6)

- Contract: providing the service you signed up for.
- Legitimate interest: fraud detection, security, aggregate analytics.
- Consent: marketing emails, AI training opt-in.
- Legal obligation: financial record retention.

## Who we share with

- **Subprocessors**: Supabase (auth + Postgres + storage), Google Cloud (Cloud SQL + Cloud Run), Vercel (web hosting), Fly.io (game server), Inngest (workers), Anthropic (LLM prompts — content-only, no PII metadata), Resend (transactional email), PostHog (analytics), Sentry (error monitoring). Stripe / Paddle when billing launches.
- **Authorities**: when legally compelled.
- **No selling** of personal data to advertisers.

## Retention

- Active account: as long as you have an account.
- Soft-deleted account: 30 days, then hard-purge.
- Financial records (`ledger_entries`, `matches`): retained per applicable financial regulations (typically 5–7 years).
- Anti-abuse logs (ban actions, fairplay flags on confirmed cheaters): up to 5 years.

## Your rights

- Access: `/account` → "Export my data".
- Erasure: `/account/privacy` → "Delete my account".
- Correction: edit fields in `/account/edit`; for corrections to immutable fields, email {PRIVACY_EMAIL}.
- Portability: export delivers a machine-readable JSON.
- Object/restrict: email {PRIVACY_EMAIL}.
- Right to delist from public profile: `POST /api/scout/delist` from your own account, or via {PRIVACY_EMAIL}.

EU/UK users may complain to a supervisory authority. California users have the rights described in our [CCPA Notice](./privacy.md#ccpa-notice).

## CCPA notice

We do not sell personal information. Categories collected: identifiers, internet activity, inferences. We retain personal information as described above.

## Children

Chessco is not directed to children under 13. Accounts created for users under 13 will be closed. Users 13–17 may use free features only.

## Security

Data in transit is TLS-protected. Data at rest is encrypted via cloud-provider defaults. Two-factor authentication is available via Supabase Auth.

## International transfers

Data is stored in EU and US data centers (per subprocessor). Where data leaves the EU/EEA we rely on Standard Contractual Clauses.

## Changes

We update this policy from time to time. Material changes are notified by email and dated above.

## Contact

{PRIVACY_EMAIL} for any privacy question. EU representative: {EU_REP}. UK representative: {UK_REP}.

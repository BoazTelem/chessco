# Cookie Policy — DRAFT

> Spec refs: §20, §24. DRAFT — lawyer review required.

**Effective date:** {EFFECTIVE_DATE}

This policy explains what cookies and similar technologies Chessco uses and why.

## What we use

| Category               | Examples                                       | Purpose                     | Lawful basis                                  |
| ---------------------- | ---------------------------------------------- | --------------------------- | --------------------------------------------- |
| **Strictly necessary** | session cookie, CSRF token, auth refresh token | Sign-in, security           | Contract / legitimate interest                |
| **Preference**         | dark mode, board theme, locale                 | Remember your settings      | Legitimate interest                           |
| **Analytics**          | PostHog identifier                             | Aggregate product analytics | Consent (EU/UK) / legitimate interest (other) |
| **Performance**        | Sentry session ID                              | Error monitoring            | Legitimate interest                           |

We do **not** use advertising cookies. We do not let third parties drop tracking cookies from our pages.

## Consent (EU/UK/CH)

Analytics cookies are gated behind your consent. You can manage your choices at `/account/privacy` → "Cookie preferences" (when shipped) or by clearing browser cookies and revisiting.

## Local storage

The web app uses browser local storage and IndexedDB to cache opening trees and PGN parser state. This data stays on your device and is not transmitted to our servers.

## Third parties

- Supabase (auth session cookies, strictly necessary)
- PostHog (analytics)
- Sentry (performance)
- Vercel (hosting; minimal session cookies)

## Contact

{PRIVACY_EMAIL} for cookie questions.

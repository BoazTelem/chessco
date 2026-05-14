# Email — Sending and Receiving for chessco.org

Authoritative reference for anything that sends or receives email on behalf of chessco.org. **Wired up 2026-05-14.**

---

## TL;DR

| Direction    | Provider                                     | Path                                                               |
| ------------ | -------------------------------------------- | ------------------------------------------------------------------ |
| **Outbound** | [Resend](https://resend.com)                 | App / Supabase Auth → `smtp.resend.com:465` → recipient            |
| **Inbound**  | [ImprovMX](https://improvmx.com) (free tier) | sender → MX `mx{1,2}.improvmx.com` → forward to `btelem@gmail.com` |
| **DNS**      | Vercel                                       | https://vercel.com/dashboard/domains → `chessco.org` → DNS Records |

Sender identity for all transactional mail: **`Chessco <no-reply@chessco.org>`**. Replies go nowhere by design; if a human needs to be reachable, link to `support@chessco.org` in the body (the catch-all forwards it).

---

## 1. Outbound — sending email from chessco.org

### 1a. Supabase Auth emails (magic link, signup confirm, password reset)

Already wired. Supabase's custom SMTP is pointed at Resend:

- Configured at: Supabase dashboard → **Authentication → Emails → SMTP Settings** (or via `auth/smtp` URL).
- Host: `smtp.resend.com` · Port `465` · Username `resend` (literal, **not** `chessco`) · Password = a Resend API key with **Sending access** scope, name `supabase-auth-smtp`.
- Sender: `no-reply@chessco.org` / display name `Chessco`.
- Email content templates: Supabase → **Authentication → Emails → Templates** (Confirm signup, Magic Link, Reset Password, Invite, etc.). Edit there, not in code.

To change any of the above, log into Supabase as `boaz@slokoto.com` (the Resend account is also `boaz@slokoto.com`, Pro plan).

### 1b. App-sent transactional email (welcome, contact-form reply, receipts, …)

**Not yet wired** — wire on-demand. Pattern when you need it:

1. Install the SDK in the app that will send: `pnpm --filter @chessco/web add resend` (or workers).
2. Create a new Resend API key in https://resend.com → **API Keys** → name it descriptively (e.g. `web-transactional`), scope **Sending access**, restrict to `chessco.org`.
3. Add `RESEND_API_KEY=re_...` to Vercel env vars for the relevant scopes (Production and Preview), mark as Sensitive.
4. Add the same key to `apps/web/.env.local` for local dev. Update `apps/web/.env.example` with a placeholder line — do **not** commit the real key.
5. Send via the SDK:

```ts
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY!);

await resend.emails.send({
  from: 'Chessco <no-reply@chessco.org>',
  to: recipient,
  reply_to: 'support@chessco.org', // optional — point replies at the catch-all
  subject: '...',
  html: '...', // or react: <EmailComponent />
});
```

6. Test locally first (Resend free tier allows sending to your own verified address only on day one; once the domain is verified — which it is — you can send to anyone).
7. Check the Resend → **Logs** dashboard for the send.

### 1c. Limits and budget

Resend account is on **Pro plan** (50,000 emails/month, no daily cap). Supabase's per-hour rate limit is set to 100/hr. If a campaign or burst would exceed that, either:

- Raise the Supabase rate limit, OR
- Bypass Supabase for transactional mail and send directly via the Resend SDK (1b) — Supabase rate limits only apply to auth-template emails.

---

## 2. Inbound — receiving email at chessco.org

### 2a. What happens to mail addressed to `*@chessco.org`

ImprovMX catch-all rule: any local-part (`support@`, `hello@`, `dmarc@`, `random123@`, …) forwards to **`btelem@gmail.com`**.

To change the destination or split into per-alias rules:

- https://app.improvmx.com → log in as `boaz@slokoto.com` → click `chessco.org` → **Aliases**.
- Edit the `*` alias (catch-all) or add explicit aliases like `support@` → `someone@elsewhere.com`. Explicit aliases take precedence over catch-all.
- Any new destination address requires email verification (ImprovMX sends a click-the-link confirmation).

### 2b. Gmail spam filter quirk

First-time forwarded mail through ImprovMX often lands in Gmail's Spam folder because ImprovMX rewrites the envelope sender (SRS). A standing Gmail filter is in place on `btelem@gmail.com`:

- Criteria: **To: `@chessco.org`** → Never send to Spam + Always mark as important.
- If forwarded mail stops appearing in Inbox, check this filter wasn't deleted.

### 2c. DMARC aggregate reports

DMARC is published as `p=none; rua=mailto:dmarc@chessco.org`. Major providers (Google, Microsoft, Yahoo) email weekly XML reports to `dmarc@chessco.org`, which the catch-all forwards to btelem@gmail.com. Open one occasionally to scan for unauthorized senders impersonating `chessco.org`. After ~30 days of clean reports, the policy can be tightened to `p=quarantine`.

### 2d. Inbound is **forward only**

ImprovMX free tier does not host mailboxes. There is no `support@chessco.org` IMAP/POP account to log into — everything goes to btelem@gmail.com. If we later want true mailboxes per address (e.g. `support@` lives in its own Gmail Workspace), that's a Workspace migration, separate task.

---

## 3. DNS records (Vercel)

All published at https://vercel.com/dashboard/domains → `chessco.org` → DNS Records. **DNS is on Vercel, not Cloudflare** — `nslookup -type=NS chessco.org` should return `ns{1,2}.vercel-dns.com`. Don't suggest Cloudflare Email Routing; it only works when the zone is on Cloudflare nameservers.

| Type | Name                | Value                                                  | Purpose                                 |
| ---- | ------------------- | ------------------------------------------------------ | --------------------------------------- |
| MX   | `send`              | `feedback-smtp.eu-west-1.amazonses.com` (priority 10)  | Resend bounce handling                  |
| TXT  | `send`              | `v=spf1 include:amazonses.com ~all`                    | SPF for Resend's outbound subdomain     |
| TXT  | `resend._domainkey` | (RSA public key)                                       | DKIM signing key for Resend             |
| TXT  | `_dmarc`            | `v=DMARC1; p=none; rua=mailto:dmarc@chessco.org; fo=1` | DMARC monitoring                        |
| MX   | (root `@`)          | `mx1.improvmx.com` (priority 10)                       | ImprovMX inbound                        |
| MX   | (root `@`)          | `mx2.improvmx.com` (priority 20)                       | ImprovMX inbound backup                 |
| TXT  | (root `@`)          | `v=spf1 include:spf.improvmx.com ~all`                 | SPF for ImprovMX SRS-rewritten forwards |

**Why subdomain split:** Resend's MX/SPF live on `send.chessco.org`, ImprovMX's on root. They don't conflict and DMARC alignment works via DKIM (`d=chessco.org` matches `From: …@chessco.org`).

If you ever need to add a sender (e.g. a third-party newsletter platform) that signs from the root domain, merge it into the root SPF rather than adding a second SPF record — DNS only allows one SPF TXT per name.

---

## 4. Region

Resend sending region is **`eu-west-1` (Dublin)**, picked to match Supabase's `aws-0-eu-central-1` Frankfurt project (Resend has no eu-central; Dublin is the closest hop). If we ever move Supabase, re-evaluate.

---

## 5. Debugging email problems

When something goes wrong with email, check in this order:

1. **Resend → Logs** (https://resend.com/logs). Filter by recipient. If the send is missing entirely, the app didn't reach Resend — Supabase SMTP creds wrong, API key revoked, or Resend down. If the send is there with status Delivered, the issue is downstream (recipient's mailbox, spam filter).
2. **Supabase → Logs → Auth** for auth emails specifically. Look for SMTP-related errors.
3. **`Authentication-Results:` header** on a received message (Gmail → Show original). Want to see `dkim=pass`, `spf=pass`, `dmarc=pass` all green. Anything else = DNS drift or sender mis-configuration.
4. **ImprovMX → Logs** for inbound (https://app.improvmx.com → `chessco.org` → Logs). Shows every message that hit your MX records, with Forwarded / Failed / Bounced status. If nothing appears, the issue is upstream of ImprovMX (DNS, sender's MTA, Gmail throttling between Gmail accounts).
5. **DNS** — `nslookup -type=TXT resend._domainkey.chessco.org 8.8.8.8` and friends. If any record is missing, Resend or DKIM verification will start failing.

Things to **not** do:

- Don't propose SendGrid, Mailgun, Postmark, or Cloudflare Email Routing. The team evaluated and chose Resend + ImprovMX. They work.
- Don't put email secrets in env vars committed to the repo. The Resend API key for Supabase Auth lives in Supabase's encrypted SMTP password field, not in code.
- Don't enable click/open tracking on a Resend domain that sends auth emails — link-rewriting consumes one-time tokens before users click. Tracking is off by default; keep it off.

---

## 6. Operational checklist for changes

Before changing anything email-related:

- [ ] Snapshot current DNS via `nslookup -type=ANY chessco.org 8.8.8.8` so rollback is one record-restore away.
- [ ] If editing Supabase SMTP, do it in staging first if possible. The Custom SMTP toggle can be flipped off as instant rollback (auth falls back to Supabase's built-in SMTP, lower rate but works).
- [ ] After any change, run all three magic-link / signup / password-reset templates from **Authentication → Users → ⋯ → Send …** and inspect headers.

---

## 7. Out of scope (future)

- **Supabase Custom Domain** ($10/mo Pro add-on) to replace `xnbrztymfqgkxmdlvhjv.supabase.co` with `auth.chessco.org` in OAuth flows. Worth doing before paid launch.
- **App-sent transactional emails** — see §1b. Wire when the corresponding features land (contact form, paid receipts, etc.).
- **DMARC tightening** — raise `p=` from `none` to `quarantine` after ~30 days of clean reports.
- **Per-alias inbound routing** — if `support@chessco.org` should reach someone other than btelem, swap the catch-all for explicit ImprovMX aliases.

---

## 8. Accounts and ownership

| Service              | Owner email        | Plan |
| -------------------- | ------------------ | ---- |
| Resend               | `boaz@slokoto.com` | Pro  |
| ImprovMX             | `boaz@slokoto.com` | Free |
| Vercel               | `boaz@slokoto.com` | Pro  |
| Supabase             | `boaz@slokoto.com` | Pro  |
| Google Cloud (OAuth) | `boaz@slokoto.com` | —    |

The Resend API key currently in use by Supabase is named `supabase-auth-smtp`. If it gets rotated, regenerate at Resend → API Keys, paste the new value into Supabase → Authentication → Emails → SMTP Settings → Password. The old key keeps working until you delete it in Resend, so there's no downtime if done in the right order.

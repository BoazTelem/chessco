import Link from 'next/link';
import { brand } from '@chessco/ui';

export const metadata = {
  title: 'Terms of Use',
  description: `Terms of Use for ${brand.name}. Draft v0.1 — pre-launch, not yet in force.`,
};

const EFFECTIVE_DATE = '2026-05-15';
const SUPPORT_EMAIL = 'support@chessco.org';

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-10 scroll-mt-20">
      <h2 className="font-display text-lg font-semibold">{title}</h2>
      <div className="mt-3 space-y-3 text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <div className="min-h-screen">
      <main className="container mx-auto max-w-3xl px-4 py-10">
        <section>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Legal</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight md:text-4xl">
            Terms of Use
          </h1>
          <p className="mt-3 text-xs text-muted-foreground">
            Draft v0.1 — published <time dateTime={EFFECTIVE_DATE}>{EFFECTIVE_DATE}</time>. This
            document is a pre-launch draft made publicly available for review and is not yet binding
            on users. The final version will be re-dated and announced before {brand.name} accepts
            payments or other commercial transactions.
          </p>
        </section>

        <Section id="acceptance" title="1. Acceptance & changes">
          <p>
            By accessing or using {brand.name} (&ldquo;the Service&rdquo;) you agree to these Terms.
            If you do not agree, do not use the Service.
          </p>
          <p>
            We may update these Terms. The current version is always available at this URL with its
            effective date. Material changes will be communicated to signed-in users by email or
            in-app notice at least 14 days before they take effect.
          </p>
        </Section>

        <Section id="about" title="2. About Chessco">
          <p>
            {brand.name} is operated by <strong className="text-foreground">Foto Master LLC</strong>{' '}
            (&ldquo;we&rdquo;, &ldquo;us&rdquo;), a Delaware limited liability company at 1013
            Centre Road, STE 403-B, Wilmington, DE 19805, United States, doing business as{' '}
            {brand.name}.
          </p>
          <p>
            The Service is currently in beta. Paid features described in our public roadmap
            (subscription tiers and the in-product credits economy) will be made available through
            Paddle, our merchant of record, when launched.
          </p>
        </Section>

        <Section id="eligibility" title="3. Eligibility">
          <p>
            You must be at least 13 years old to use the Service. Residents of the European Economic
            Area, the United Kingdom, and other jurisdictions with a higher digital-services age of
            consent must be 16 or older, or have verifiable parental consent.
          </p>
        </Section>

        <Section id="account" title="4. Account & security">
          <p>
            You are responsible for keeping your sign-in credentials secure and for activity on your
            account. Notify us at{' '}
            <a className="text-foreground underline" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>{' '}
            if you believe your account has been compromised.
          </p>
        </Section>

        <Section id="service" title="5. The Service">
          <p>
            <strong className="text-foreground">Scout</strong> identifies likely chess.com and
            Lichess accounts for a named player using public rating-list data and statistical match
            against the games we have indexed. Scout output is a best-guess ranked list, not a
            determination of identity, and should not be relied on as proof of who controls an
            account.
          </p>
          <p>
            <strong className="text-foreground">Prepare</strong> fetches public games for an account
            you specify and builds an opening tree and per-line statistics. We do not represent that
            our copy of a player&apos;s games is current to the moment — there is always some lag
            between the source platform and our index.
          </p>
          <p>
            <strong className="text-foreground">Practice</strong> lets you publish a position from
            your prep work and play it against another user. Free practice exchanges no credits;
            paid practice spends 1 credit per game from the publisher and rewards the opponent 1
            credit per completed game. Any future paid feature will require an additional
            click-through agreement before you can use it.
          </p>
        </Section>

        <Section id="credits" title="6. Credits">
          <p>
            <strong className="text-foreground">Credits</strong> are an internal, non-monetary
            balance used to spend on and earn from features of the Service. Credits have no cash
            value and are not money, currency, securities, or stored-value instruments. They are
            <strong className="text-foreground">
              {' '}
              not redeemable, transferable, or withdrawable for cash or any other form of value
            </strong>{' '}
            outside the Service, and they are not subject to the rules that apply to deposit
            accounts, prepaid access, or e-money.
          </p>
          <p>
            Credits are granted to you (for example as a signup bonus, a subscription benefit, a
            referral reward, or as a reward for completing paid practice games) and consumed when
            you publish a paid practice challenge or unlock certain features. Subscription credits
            expire at the end of each billing cycle; other credit grants do not expire unless we
            disclose a different expiry at the time of the grant.
          </p>
          <p>
            We may modify, suspend, expire, or revoke credit balances at any time, including to
            address suspected abuse such as collusion, multi-account farming, fraud, or violations
            of these Terms. We may impose caps on how many credits can be earned in a given window
            or from a given counterpart. We are not obligated to refund credits in cash under any
            circumstance.
          </p>
        </Section>

        <Section id="billing" title="7. Subscriptions, billing, refunds & taxes">
          <p>
            Paid plans on the Service are sold on a subscription basis.{' '}
            <strong className="text-foreground">
              Payments may be processed by Paddle, our merchant of record. We do not store your full
              card details.
            </strong>{' '}
            Paddle handles billing, invoicing, and the calculation and remittance of applicable
            sales tax, VAT, GST, or equivalent indirect taxes where required.
          </p>
          <p>
            <strong className="text-foreground">Refunds.</strong> You may cancel and request a full
            refund within 14 days of your initial paid charge without giving a reason. After the
            14-day window, fees are non-refundable except where required by law or expressly
            approved by us. Subscription credits that you have already consumed during a refunded
            period will not be clawed back.
          </p>
          <p>
            <strong className="text-foreground">Cancellation.</strong> If you signed up online, you
            may cancel online. Cancellation stops future renewals but does not reverse fees already
            incurred unless required by law or expressly approved.
          </p>
          <p>
            <strong className="text-foreground">Plan changes.</strong> You may upgrade or downgrade
            your subscription at any time. Upgrades take effect immediately and credits granted by
            the new tier are added to your balance; downgrades take effect at the end of the current
            billing cycle. We do not pro-rate downgrades.
          </p>
        </Section>

        <Section id="acceptable-use" title="8. Acceptable use">
          <p>You agree not to:</p>
          <ul className="ml-5 list-disc space-y-1">
            <li>Use the Service to harass, dox, impersonate, or target any person.</li>
            <li>
              Scrape, crawl, or systematically extract data from the Service except via documented
              public endpoints used within reasonable rate limits.
            </li>
            <li>
              Use Scout output as the basis for any high-stakes decision about a real person —
              including but not limited to employment, contracting, fraud allegations, or
              tournament-integrity rulings. Scout is a probabilistic tool, not an identification
              service.
            </li>
            <li>
              Violate the terms of service of any third-party platform (including chess.com and
              Lichess) through your use of {brand.name}.
            </li>
            <li>
              Attempt to bypass any rate limit, authentication, or access control on the Service.
            </li>
            <li>
              Use the Service for cheating in chess, including in matches arranged through it.
            </li>
          </ul>
        </Section>

        <Section id="linked-accounts" title="9. Linked external accounts">
          <p>
            When you link a chess.com or Lichess account to your {brand.name} profile, you authorize
            us to read public data about that account on an ongoing basis, plus any additional data
            the platform exposes to us after you complete the platform&apos;s verification step. You
            can unlink at any time from your account settings; we will stop refreshing data from the
            unlinked account, though already-indexed historical games may remain in the index
            subject to our removal policy (see{' '}
            <Link href="/privacy#indexing" className="text-foreground underline">
              Privacy Policy §4
            </Link>
            ).
          </p>
        </Section>

        <Section id="user-content" title="10. User content">
          <p>
            You retain ownership of any content you submit (uploaded PGNs, prep notes, profile
            details). You grant {brand.name} a worldwide, non-exclusive, royalty-free licence to
            host, copy, and process that content solely to provide and improve the Service.
          </p>
        </Section>

        <Section id="ip" title="11. Intellectual property">
          <p>
            The {brand.name} name, mark, original written content, UI, and code are owned by us or
            our licensors and are protected by intellectual-property law.
          </p>
          <p>
            Indexed third-party chess data — including games, ratings, titles, and federation
            information — belongs to its respective sources. Lichess game data is published by
            Lichess under the Creative Commons CC0 1.0 Universal dedication. Other sources rely on
            their own public-availability terms; we operate within those terms and honour removal
            requests as described in the Privacy Policy.
          </p>
        </Section>

        <Section id="disclaimers" title="12. Disclaimers">
          <p>
            THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT
            WARRANTY OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING WARRANTIES OF
            MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, OR ACCURACY.
          </p>
          <p>
            Without limiting the foregoing: Scout matches are statistical estimates and may be
            wrong; opening trees may be outdated; rating data may have ingest lag. Do not treat any
            Service output as authoritative.
          </p>
        </Section>

        <Section id="liability" title="13. Limitation of liability">
          <p>
            To the maximum extent permitted by law, {brand.name} and its operators will not be
            liable for any indirect, incidental, special, consequential, or punitive damages, or any
            loss of profits, revenue, data, or goodwill, arising from your use of the Service.
          </p>
          <p>
            Our aggregate liability for any direct damages arising from the Service is capped at the
            greater of (a) the total fees you paid to us in the 12 months immediately preceding the
            event giving rise to the claim, or (b) fifty US dollars (USD 50).
          </p>
        </Section>

        <Section id="indemnification" title="14. Indemnification">
          <p>
            You agree to indemnify and hold {brand.name} and its operators harmless from any claim
            or demand, including reasonable attorneys&apos; fees, made by any third party arising
            from your breach of these Terms, your user content, or your violation of any third
            party&apos;s rights.
          </p>
        </Section>

        <Section id="termination" title="15. Termination">
          <p>
            We may suspend or terminate your account for material breach of these Terms or for
            conduct that risks harm to the Service or to other users.
          </p>
          <p>
            You can delete your account at any time from your settings page or by writing to{' '}
            <a className="text-foreground underline" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
            . Sections that by their nature should survive termination (intellectual property,
            disclaimers, limitation of liability, governing law) will survive.
          </p>
        </Section>

        <Section id="law" title="16. Governing law and dispute resolution">
          <p>
            These Terms are governed by applicable law as determined by {brand.name}. Before filing
            a formal claim, you agree to contact us and attempt to resolve the dispute informally.
          </p>
        </Section>

        <Section id="contact" title="17. Contact">
          <p>
            Questions about these Terms? Email{' '}
            <a className="text-foreground underline" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </Section>

        <section className="mt-10 border-t border-border pt-6 text-xs text-muted-foreground">
          <p>
            See also our{' '}
            <Link href="/privacy" className="text-foreground underline">
              Privacy Policy
            </Link>
            .
          </p>
        </section>
      </main>
    </div>
  );
}

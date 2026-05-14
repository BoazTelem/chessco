import Link from 'next/link';
import { brand } from '@chessco/ui';

export const metadata = {
  title: 'Terms of Use',
  description: `Terms of Use for ${brand.name}. Draft v0.1 — pre-launch, not yet in force.`,
};

const EFFECTIVE_DATE = '2026-05-13';
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
            {brand.name} is operated as an unincorporated project; a registered legal entity may
            assume ownership and operations before the Service offers paid features. When that
            happens we will update these Terms with the entity name and registration details.
          </p>
          <p>
            The Service is currently in beta. All features are offered free of charge today. Paid
            features described in our public roadmap (the practice marketplace, payouts,
            subscriptions) are not yet operative.
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
            <strong className="text-foreground">Practice</strong> and related marketplace features
            are described in our roadmap but are not currently available. Any future paid feature
            will require an additional click-through agreement before you can use it.
          </p>
        </Section>

        <Section id="acceptable-use" title="6. Acceptable use">
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

        <Section id="linked-accounts" title="7. Linked external accounts">
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

        <Section id="user-content" title="8. User content">
          <p>
            You retain ownership of any content you submit (uploaded PGNs, prep notes, profile
            details). You grant {brand.name} a worldwide, non-exclusive, royalty-free licence to
            host, copy, and process that content solely to provide and improve the Service.
          </p>
        </Section>

        <Section id="ip" title="9. Intellectual property">
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

        <Section id="disclaimers" title="10. Disclaimers">
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

        <Section id="liability" title="11. Limitation of liability">
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

        <Section id="indemnification" title="12. Indemnification">
          <p>
            You agree to indemnify and hold {brand.name} and its operators harmless from any claim
            or demand, including reasonable attorneys&apos; fees, made by any third party arising
            from your breach of these Terms, your user content, or your violation of any third
            party&apos;s rights.
          </p>
        </Section>

        <Section id="termination" title="13. Termination">
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

        <Section id="law" title="14. Governing law & venue">
          <p>
            These Terms are governed by the laws of the State of Israel, without regard to
            conflict-of-laws principles. The competent courts of Tel Aviv-Yafo, Israel, have
            exclusive jurisdiction over any dispute arising out of or relating to these Terms or
            your use of the Service, save that we may seek injunctive relief in any court of
            competent jurisdiction to protect our intellectual property.
          </p>
          <p>
            If you are a consumer resident in the European Economic Area, the United Kingdom, or
            another jurisdiction whose mandatory consumer-protection rules cannot be derogated from
            by agreement, those rules continue to apply to you in addition to this clause.
          </p>
        </Section>

        <Section id="contact" title="15. Contact">
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

import Link from 'next/link';
import { brand } from '@chessco/ui';
import { ChesscoMark } from '@/lib/logo';

export const metadata = {
  title: 'Privacy Policy',
  description: `Privacy Policy for ${brand.name}. Draft v0.1 — pre-launch, not yet in force.`,
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

export default function PrivacyPage() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card/50">
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2 text-sm">
            <Link
              href="/"
              aria-label={brand.name}
              className="inline-flex items-center gap-2 hover:opacity-80"
            >
              <ChesscoMark className="h-4 w-4 shrink-0" />
              <span className="font-display font-semibold uppercase tracking-[0.3em] text-accent">
                {brand.name}
              </span>
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="text-foreground">Privacy Policy</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-3xl px-4 py-10">
        <section>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">Legal</p>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight md:text-4xl">
            Privacy Policy
          </h1>
          <p className="mt-3 text-xs text-muted-foreground">
            Draft v0.1 — published <time dateTime={EFFECTIVE_DATE}>{EFFECTIVE_DATE}</time>. This
            document is a pre-launch draft made publicly available for review. The data-handling
            practices described here reflect what {brand.name} does today; the formal effective date
            will be re-stated before {brand.name} begins charging users.
          </p>
        </section>

        <Section id="who-we-are" title="1. Who we are">
          <p>
            {brand.name} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) operates the website at{' '}
            <span className="text-foreground">{brand.domain}</span> and the related services
            described on it. We are currently operated as an unincorporated project from Israel; a
            registered legal entity may take over operations before paid features launch, and we
            will update this Policy with its name and registered address when that happens.
          </p>
          <p>
            For all privacy questions, contact{' '}
            <a className="text-foreground underline" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </Section>

        <Section id="what-we-collect" title="2. What we collect">
          <p>
            <strong className="text-foreground">Account data</strong> — when you create an account
            we collect your email address (or the email associated with your Google sign-in), a
            chosen username, an optional display name, and your country. If you sign in via Google
            OAuth we receive the standard OAuth profile claims (subject id, name, email, picture
            URL).
          </p>
          <p>
            <strong className="text-foreground">Linked external accounts</strong> — when you link a
            chess.com or Lichess account, we store the platform name, the external account
            identifier, and the verification status of the link.
          </p>
          <p>
            <strong className="text-foreground">Public chess data we index</strong> — independently
            of any user account, we maintain an index of publicly available chess data: player
            handles, games (PGNs), ratings, titles, and federation information sourced from
            chess.com, Lichess, FIDE, USCF, and the Israeli Chess Federation. This data describes
            people who may not have a {brand.name} account. See §4 for your rights regarding this
            index.
          </p>
          <p>
            <strong className="text-foreground">Derived data</strong> — from indexed games we
            compute style fingerprints, opening repertoires, and per-position statistics used to
            generate prep reports and Scout matches.
          </p>
          <p>
            <strong className="text-foreground">Server logs</strong> — IP address, user agent,
            timestamps, requested URLs, and response codes. We retain these for security and
            reliability investigation.
          </p>
        </Section>

        <Section id="legal-bases" title="3. Legal bases (GDPR)">
          <p>
            Where the EU/UK General Data Protection Regulation applies, we rely on the following
            legal bases:
          </p>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              <strong className="text-foreground">Performance of a contract</strong> — to provide
              the account, prep, and (in future) paid services you sign up for.
            </li>
            <li>
              <strong className="text-foreground">Legitimate interest</strong> — to index publicly
              available chess data for the purpose of providing scouting and preparation tools to
              the chess community, and to investigate abuse and secure the Service. We have weighed
              this interest against the privacy impact on data subjects and provide an opt-out
              mechanism described below.
            </li>
            <li>
              <strong className="text-foreground">Consent</strong> — if and when we introduce
              analytics or marketing cookies, we will request consent before any such cookie is set.
              We do not currently use any such cookies (see §5).
            </li>
            <li>
              <strong className="text-foreground">Legal obligation</strong> — where retention or
              disclosure is required by applicable law.
            </li>
          </ul>
        </Section>

        <Section id="indexing" title="4. The public-data index — your rights">
          <p>
            {brand.name} indexes publicly available chess data from chess.com, Lichess, FIDE, USCF,
            and the Israeli Chess Federation. Lichess publishes its monthly game dumps under the
            Creative Commons CC0 1.0 Universal dedication; for other sources we operate within their
            published terms and at conservative rate limits.
          </p>
          <p>
            <strong className="text-foreground">
              If you do not want your public handle to appear
            </strong>{' '}
            in {brand.name}, email{' '}
            <a className="text-foreground underline" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>{' '}
            from any address with the platform and handle, and we will remove the handle and its
            associated games from the index within 14 days. We honour these requests regardless of
            jurisdiction. If your data is in our index because you have a {brand.name} account
            linked to that handle, you can also unlink the account from your settings page or delete
            your {brand.name} account entirely.
          </p>
          <p>
            Under GDPR Article 21 you have the right to object to processing based on legitimate
            interest. The email above is how you exercise that right with us. We will stop the
            processing unless we can demonstrate compelling legitimate grounds that override your
            interests.
          </p>
        </Section>

        <Section id="cookies" title="5. Cookies and similar technology">
          <p>
            {brand.name} uses a small number of strictly-necessary cookies for authentication and
            session management. These cookies are set by our authentication provider (Supabase) and
            are exempt from prior-consent requirements under the EU ePrivacy Directive and UK PECR
            because they are necessary to deliver a service you explicitly requested (signing in).
          </p>
          <p>
            We do <strong className="text-foreground">not</strong> currently set any analytics,
            advertising, social-media, A/B-testing, fingerprinting, or other non-essential cookies.
            If we introduce any in the future we will display a cookie-consent banner with a reject
            option of equal prominence before setting them.
          </p>
        </Section>

        <Section id="how-we-use" title="6. How we use your data">
          <ul className="ml-5 list-disc space-y-1">
            <li>To create and operate your account.</li>
            <li>To produce prep reports, opening trees, and Scout matches you request.</li>
            <li>To measure and improve the accuracy of our Scout matcher.</li>
            <li>To send transactional emails (account, security, important service notices).</li>
            <li>To detect, investigate, and prevent abuse, fraud, and cheating.</li>
            <li>To comply with legal obligations.</li>
          </ul>
        </Section>

        <Section id="sharing" title="7. Sharing and sub-processors">
          <p>
            We do not sell your personal data. We share data with the following sub-processors that
            are necessary to run the Service:
          </p>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              <strong className="text-foreground">Supabase</strong> — managed PostgreSQL and
              authentication. Hosts account, profile, link, and prep data.
            </li>
            <li>
              <strong className="text-foreground">Vercel</strong> — hosting and edge delivery of the
              web application.
            </li>
            <li>
              <strong className="text-foreground">Google</strong> — if you sign in with Google,
              receives the standard OAuth request from your browser. Google&apos;s own privacy
              policy governs that interaction.
            </li>
            <li>
              <strong className="text-foreground">Source platforms</strong> (chess.com, Lichess,
              FIDE, USCF, ICF) — we fetch public data from their public endpoints; they receive only
              what their endpoints would normally receive (request metadata) and not your{' '}
              {brand.name} account data.
            </li>
          </ul>
          <p>
            We may disclose information to comply with valid legal process, to enforce our Terms, or
            to protect the safety of users.
          </p>
        </Section>

        <Section id="transfers" title="8. International transfers">
          <p>
            The Service is operated from Israel and uses sub-processors with infrastructure in the
            European Economic Area and the United States, depending on the region selected for each
            sub-processor. Where personal data is transferred from the EEA or the UK to a country
            without an adequacy decision, we rely on the European Commission&apos;s Standard
            Contractual Clauses (or the UK Addendum to them) as the safeguard for the transfer.
          </p>
        </Section>

        <Section id="retention" title="9. Retention">
          <ul className="ml-5 list-disc space-y-1">
            <li>
              <strong className="text-foreground">Account data:</strong> while your account exists,
              plus 30 days after deletion to reverse accidental deletion and to retain
              integrity-related records.
            </li>
            <li>
              <strong className="text-foreground">Server logs:</strong> 30 days, then deleted or
              fully aggregated.
            </li>
            <li>
              <strong className="text-foreground">Public-data index:</strong> retained indefinitely
              unless a removal request is received (see §4).
            </li>
            <li>
              <strong className="text-foreground">Transactional records:</strong> if and when paid
              features go live, billing records will be retained as required by Israeli tax and
              consumer-protection law.
            </li>
          </ul>
        </Section>

        <Section id="security" title="10. Security">
          <p>
            Data is encrypted in transit (HTTPS/TLS). Sign-in credentials are stored as
            cryptographic hashes by our authentication provider. Database access is restricted by
            row-level security policies. We do not claim that our security is perfect; we will
            notify affected users and competent authorities of material incidents as required by
            applicable law.
          </p>
        </Section>

        <Section id="your-rights" title="11. Your rights">
          <p>Depending on where you live, you may have the right to:</p>
          <ul className="ml-5 list-disc space-y-1">
            <li>Access the personal data we hold about you.</li>
            <li>Have inaccurate data corrected.</li>
            <li>Have your data erased.</li>
            <li>Receive your data in a portable format.</li>
            <li>Restrict or object to certain processing.</li>
            <li>Withdraw consent where processing is based on consent.</li>
          </ul>
          <p>
            To exercise any of these rights, email{' '}
            <a className="text-foreground underline" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
            . We may need to verify your identity before responding to a request that concerns an
            account.
          </p>
          <p>
            <strong className="text-foreground">EU/UK residents:</strong> you have the right to
            lodge a complaint with your national data-protection authority.{' '}
            <strong className="text-foreground">Israeli residents:</strong> you may complain to the
            Israeli Privacy Protection Authority (PPA).{' '}
            <strong className="text-foreground">California residents:</strong> you have rights under
            the CCPA/CPRA. We do not sell or share personal data as those terms are defined under
            California law.
          </p>
        </Section>

        <Section id="children" title="12. Children">
          <p>
            The Service is not directed to children under 13 (or under 16 in the EEA, UK, and other
            jurisdictions with a higher digital-services age of consent). We do not knowingly
            collect personal data from children below those thresholds. If you believe we have,
            contact {SUPPORT_EMAIL} and we will delete the data.
          </p>
        </Section>

        <Section id="changes" title="13. Changes to this Policy">
          <p>
            We will post a new version of this Policy at this URL with a new effective date. For
            material changes we will give signed-in users at least 14 days&apos; notice by email or
            in-app notice before the change takes effect.
          </p>
        </Section>

        <Section id="contact" title="14. Contact">
          <p>
            For any privacy question, request, or complaint, email{' '}
            <a className="text-foreground underline" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </Section>

        <section className="mt-10 border-t border-border pt-6 text-xs text-muted-foreground">
          <p>
            See also our{' '}
            <Link href="/terms" className="text-foreground underline">
              Terms of Use
            </Link>
            .
          </p>
        </section>
      </main>
    </div>
  );
}

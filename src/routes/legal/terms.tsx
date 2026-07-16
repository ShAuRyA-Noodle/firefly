// TEMPLATE — REVIEW WITH LAWYER BEFORE LAUNCH
import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/legal/terms')({
  component: TermsPage,
})

function TermsPage() {
  return (
    <div className="min-h-screen w-full overflow-y-auto bg-void">
      <div className="max-w-3xl mx-auto px-6 py-16 pb-32">
        <header className="mb-12 space-y-4">
          <Link
            to="/"
            className="kicker text-ash hover:text-bone no-underline inline-block"
          >
            ← back to firefly
          </Link>
          <h1 className="display-title text-5xl md:text-6xl text-bone">
            TERMS OF<br />SERVICE
          </h1>
          <p className="text-ash text-xs font-mono tracking-widest uppercase">
            Last updated: 2026-05-07
          </p>
          <p className="text-smoke text-[11px] font-mono italic">
            Template content. Have a lawyer review before launch.
          </p>
        </header>

        <article className="prose prose-lg prose-invert max-w-none text-bone/90">
          <h2>1. Acceptance of Terms</h2>
          <p>
            By accessing or using Firefly ("the Service"), you agree to be bound by
            these Terms of Service. If you do not agree, do not use the Service.
          </p>

          <h2>2. Eligibility</h2>
          <p>
            You must be at least 13 years old to use Firefly. If you are under 18,
            you confirm you have permission from a parent or legal guardian. By
            creating an account you represent that you meet these requirements.
          </p>

          <h2>3. Acceptable Use</h2>
          <p>You agree not to:</p>
          <ul>
            <li>Abuse, harass, or harm other users or our staff</li>
            <li>Scrape, mirror, or programmatically harvest any portion of the Service</li>
            <li>Reverse-engineer, redistribute, or attempt to extract our prompts, models, or source assets</li>
            <li>Use the Service to violate any law or third-party intellectual property rights</li>
            <li>Upload malicious content, spam, or misleading information</li>
            <li>Attempt to bypass rate limits, authentication, or other technical safeguards</li>
          </ul>

          <h2>4. AI Disclaimer</h2>
          <p>
            Firefly generates responses using third-party AI models. Output may be
            inaccurate, incomplete, biased, or fabricated. <strong>Do not rely on
            Firefly for medical, legal, financial, safety, or other consequential
            decisions.</strong> Always verify important information with a qualified
            human professional or authoritative source.
          </p>

          <h2>5. User Content</h2>
          <p>
            You retain ownership of the questions and content you submit. By
            submitting, you grant us a non-exclusive license to process, store, and
            display that content in order to operate and improve the Service.
          </p>

          <h2>6. Termination</h2>
          <p>
            We may suspend or terminate your access at any time, with or without
            notice, for breach of these terms or for any conduct we determine to be
            harmful to the Service or other users. You may stop using the Service
            and delete your account at any time.
          </p>

          <h2>7. Changes to These Terms</h2>
          <p>
            We may update these terms periodically. Material changes will be
            announced via the Service or by email at least 14 days before they take
            effect. Continued use after the effective date constitutes acceptance.
          </p>

          <h2>8. Disclaimers and Limitation of Liability</h2>
          <p>
            The Service is provided "as is" without warranties of any kind. To the
            maximum extent permitted by law, Firefly and its operators shall not be
            liable for any indirect, incidental, special, consequential, or punitive
            damages, or any loss of profits, data, or goodwill arising from your use
            of the Service. Aggregate liability shall not exceed the amount you paid
            us, if any, in the twelve months prior to the claim.
          </p>

          <h2>9. Governing Law</h2>
          <p>
            These terms are governed by the laws of the jurisdiction in which the
            operator of Firefly resides, without regard to conflict-of-law
            principles. Disputes shall be resolved in the courts of that
            jurisdiction.
          </p>

          <h2>10. Contact</h2>
          <p>
            Questions about these terms? Reach us at our support email listed on the
            home page.
          </p>
        </article>
      </div>
    </div>
  )
}

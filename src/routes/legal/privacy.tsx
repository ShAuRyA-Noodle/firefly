// TEMPLATE — REVIEW WITH LAWYER BEFORE LAUNCH
import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/legal/privacy')({
  component: PrivacyPage,
})

function PrivacyPage() {
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
            PRIVACY<br />POLICY
          </h1>
          <p className="text-ash text-xs font-mono tracking-widest uppercase">
            Last updated: 2026-05-07
          </p>
          <p className="text-smoke text-[11px] font-mono italic">
            Template content. Have a lawyer review before launch.
          </p>
        </header>

        <article className="prose prose-lg prose-invert max-w-none text-bone/90">
          <h2>1. What We Collect</h2>
          <p>To run Firefly we store the following data tied to your account:</p>
          <ul>
            <li><strong>Email address</strong> — for sign-in and account recovery</li>
            <li><strong>Password hash</strong> — never the plaintext password</li>
            <li><strong>Anonymous ID</strong> — assigned before sign-up to keep work continuity</li>
            <li><strong>Threads</strong> — your conversation history with Firefly</li>
            <li><strong>Explanations</strong> — generated visual answer plans tied to your questions</li>
            <li><strong>Narrations and audio blobs</strong> — TTS audio generated for your sessions</li>
            <li><strong>Quiz attempts</strong> — questions you answered and your responses</li>
            <li><strong>Memories and concepts</strong> — derived facts the tutor remembers about your learning</li>
            <li><strong>Usage events</strong> — minimal analytics (route hits, action counts) for reliability and abuse prevention</li>
          </ul>

          <h2>2. How Long We Keep It</h2>
          <ul>
            <li><strong>Usage events:</strong> retained for 90 days, then deleted</li>
            <li><strong>Threads, explanations, narrations, memories, concepts:</strong> retained indefinitely until you delete your account or the specific item</li>
            <li><strong>Audio blobs:</strong> retained alongside their parent narration; deleted when the parent is deleted</li>
            <li><strong>Account data:</strong> deleted within 30 days of an account-deletion request</li>
          </ul>

          <h2>3. Your Rights (GDPR / CCPA-style)</h2>
          <p>If you reside in the EU, UK, California, or another jurisdiction with comparable laws, you have the right to:</p>
          <ul>
            <li><strong>Access</strong> — get a copy of the personal data we hold about you</li>
            <li><strong>Rectification</strong> — correct inaccurate data</li>
            <li><strong>Erasure</strong> — delete your account and associated data</li>
            <li><strong>Portability</strong> — export your threads and explanations in a machine-readable format</li>
            <li><strong>Restriction / Objection</strong> — limit how we process your data</li>
          </ul>
          <p>To exercise these rights, contact the email at the bottom of this page. We respond within 30 days.</p>

          <h2>4. Third-Party Processors</h2>
          <p>We share the minimum necessary data with these vendors to operate the Service:</p>
          <ul>
            <li>
              <strong>Groq</strong> — runs the LLM that generates answers. Your prompt and conversation
              context are sent to Groq for processing. See{' '}
              <a href="https://groq.com/privacy-policy/" target="_blank" rel="noreferrer">
                Groq's privacy policy
              </a>.
            </li>
            <li>
              <strong>Sarvam AI</strong> — generates the narration audio. The text we synthesize is sent
              to Sarvam. See{' '}
              <a href="https://www.sarvam.ai/privacy" target="_blank" rel="noreferrer">
                Sarvam's privacy policy
              </a>.
            </li>
            <li>
              <strong>Resend</strong> — sends transactional email (sign-in codes, password resets). Your
              email address is shared with Resend. See{' '}
              <a href="https://resend.com/legal/privacy-policy" target="_blank" rel="noreferrer">
                Resend's privacy policy
              </a>.
            </li>
          </ul>
          <p>We do not sell your personal data.</p>

          <h2>5. Cookies and Tracking</h2>
          <p>
            Firefly uses a single auth session cookie to keep you signed in. We do not
            use third-party analytics, advertising, or cross-site tracking cookies.
            Disabling the auth cookie will prevent you from signing in.
          </p>

          <h2>6. Security</h2>
          <p>
            Passwords are hashed with industry-standard algorithms. Data in transit
            is encrypted via TLS. We restrict internal access to user data on a
            need-to-know basis. No system is perfectly secure — promptly notify us if
            you suspect unauthorized access.
          </p>

          <h2>7. Children</h2>
          <p>
            Firefly is not directed at children under 13. We do not knowingly
            collect data from children under 13. If you believe a child has
            registered, contact us and we will remove the account.
          </p>

          <h2>8. Changes to This Policy</h2>
          <p>
            We may update this policy. Material changes will be announced via the
            Service or by email at least 14 days before they take effect.
          </p>

          <h2>9. Contact</h2>
          <p>
            For data requests, questions, or concerns about this policy, reach us at
            our support email listed on the home page.
          </p>
        </article>
      </div>
    </div>
  )
}

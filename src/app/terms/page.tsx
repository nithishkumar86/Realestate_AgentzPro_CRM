import Link from "next/link";
import type { Metadata } from "next";
import styles from "../privacy-policy/privacy-policy.module.css";

export const metadata: Metadata = {
  title: "Terms of Service | AgentzPro CRM",
  description:
    "Terms of Service for AgentzPro CRM, operated by AI Digital Tamizha: accounts, free trial, subscriptions, cancellation and refunds, acceptable use, and your data.",
};

const EFFECTIVE_DATE = "October 15, 2026";
const LAST_UPDATED = "October 15, 2026";

function SiteHeader() {
  return (
    <header className={styles.siteHeader}>
      <div className={styles.siteHeaderInner}>
        <Link href="/" className={styles.brand}>
          <span className={styles.brandMark}>AP</span>
          <span className={styles.brandText}>
            <span className={styles.brandName}>AgentzPro CRM</span>
            <span className={styles.brandSub}>by AI Digital Tamizha</span>
          </span>
        </Link>
        <Link href="/" className={styles.navLink}>
          &larr; Back to Home
        </Link>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className={styles.siteFooter}>
      <div className={`${styles.container} ${styles.footerInner}`}>
        <span>
          &copy; {new Date().getFullYear()} AI Digital Tamizha. All rights
          reserved.
        </span>
        <nav className={styles.footerLinks}>
          <Link href="/">Home</Link>
          <Link href="/privacy-policy">Privacy Policy</Link>
          <Link href="/contact">Contact Us</Link>
        </nav>
      </div>
    </footer>
  );
}

const TOC = [
  ["agreement", "1. Agreement to These Terms"],
  ["the-service", "2. The Service"],
  ["accounts", "3. Accounts & Companies"],
  ["trial", "4. Free Trial"],
  ["subscriptions", "5. Subscriptions & Payments"],
  ["cancellation", "6. Cancellation & Refunds"],
  ["meta", "7. Meta (Facebook) Integration"],
  ["your-data", "8. Your Data & Leads"],
  ["acceptable-use", "9. Acceptable Use"],
  ["suspension", "10. Suspension & Termination"],
  ["availability", "11. Service Availability & Changes"],
  ["disclaimer", "12. Disclaimer of Warranties"],
  ["liability", "13. Limitation of Liability"],
  ["governing-law", "14. Governing Law"],
  ["changes", "15. Changes to These Terms"],
  ["contact", "16. Contact Us"],
] as const;

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <main id="top" className={`${styles.container} ${styles.policyWrap}`}>
        <div className={styles.policyHeader}>
          <span className={styles.policyBadge}>Terms of Service</span>
          <h1 className={styles.policyTitle}>AgentzPro CRM Terms of Service</h1>
          <p className={styles.policyMeta}>
            Effective Date: {EFFECTIVE_DATE} &middot; Last Updated:{" "}
            {LAST_UPDATED}
          </p>
          <p className={styles.policyIntro}>
            These Terms of Service (&quot;Terms&quot;) are a legal agreement
            between you and <strong>AI Digital Tamizha</strong> (&quot;we&quot;,
            &quot;us&quot;, or &quot;our&quot;), the owner and operator of{" "}
            <strong>AgentzPro CRM</strong> (the &quot;Service&quot;), a
            multi-tenant, business-to-business customer relationship
            management platform that connects to Meta (Facebook) Lead Ads.
            Please read them carefully. By creating an account or using the
            Service you agree to these Terms and to our{" "}
            <Link className={styles.link} href="/privacy-policy">
              Privacy Policy
            </Link>
            .
          </p>
        </div>

        <nav className={styles.toc} aria-label="Table of contents">
          <p className={styles.tocTitle}>On this page</p>
          <ul className={styles.tocList}>
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <section id="agreement" className={styles.section}>
          <span className={styles.sectionNum}>01</span>
          <h2 className={styles.sectionTitle}>Agreement to These Terms</h2>
          <p>
            By signing up, logging in, or otherwise using AgentzPro CRM you
            confirm that you have read and agree to these Terms. If you use
            the Service on behalf of a business, you confirm that you have the
            authority to bind that business, and &quot;you&quot; includes that
            business. The Service is intended for business use only and is not
            offered to individuals under 18 years of age. If you do not agree
            to these Terms, do not use the Service.
          </p>
        </section>

        <section id="the-service" className={styles.section}>
          <span className={styles.sectionNum}>02</span>
          <h2 className={styles.sectionTitle}>The Service</h2>
          <p>
            AgentzPro CRM lets a business receive leads generated by its own
            Meta Lead Ads, organize and track those leads, assign them to team
            members, record notes and follow-up tasks, and view simple
            reports. Each company&apos;s data is kept separate from every
            other company&apos;s data. Features may be added, changed, or
            removed over time.
          </p>
        </section>

        <section id="accounts" className={styles.section}>
          <span className={styles.sectionNum}>03</span>
          <h2 className={styles.sectionTitle}>Accounts &amp; Companies</h2>
          <ul>
            <li>
              <strong>One login, one company.</strong> Each login belongs to a
              single company. A person who already has an account cannot be
              added to a second company with the same login.
            </li>
            <li>
              <strong>Owner and team members.</strong> The person who creates
              the company is its owner. The owner manages billing, connects
              Meta accounts, and can invite, block, or re-enable team members
              and assign them roles. The owner is responsible for the actions
              of the people they invite.
            </li>
            <li>
              <strong>Accurate information.</strong> You must provide accurate
              details when you sign up and keep them up to date.
            </li>
            <li>
              <strong>Keep your login secure.</strong> You are responsible for
              all activity under your account. Do not share your login. Tell
              us immediately if you believe your account has been accessed
              without permission. For your protection, an inactive session may
              be signed out automatically.
            </li>
          </ul>
        </section>

        <section id="trial" className={styles.section}>
          <span className={styles.sectionNum}>04</span>
          <h2 className={styles.sectionTitle}>Free Trial</h2>
          <p>
            A new company starts with a 14-day free trial that includes every
            Pro feature. No payment details are needed to start. When the
            trial ends, your data is kept safe but access to the CRM is paused
            until the company owner subscribes to a paid plan. We may change
            or withdraw the free trial at any time, and the trial is intended
            once per company.
          </p>
        </section>

        <section id="subscriptions" className={styles.section}>
          <span className={styles.sectionNum}>05</span>
          <h2 className={styles.sectionTitle}>Subscriptions &amp; Payments</h2>
          <ul>
            <li>
              <strong>Per-seat pricing.</strong> Paid plans are priced per
              seat, where one seat is one person in your company, including
              the owner. The current prices are shown on our{" "}
              <Link className={styles.link} href="/pricing">
                Pricing page
              </Link>
              .
            </li>
            <li>
              <strong>Monthly or yearly.</strong> You choose to be billed
              monthly or yearly.
            </li>
            <li>
              <strong>Automatic renewal.</strong> Subscriptions renew
              automatically at the end of each billing period at the then
              current price until you cancel. By subscribing you authorize
              recurring charges to your chosen payment method.
            </li>
            <li>
              <strong>Payment processing.</strong> Payments are processed by
              our payment partner, Razorpay. We do not store your card or bank
              details. Prices are in Indian Rupees (INR) and any applicable
              taxes are added as required by law.
            </li>
            <li>
              <strong>Failed payments.</strong> If a payment fails, access to
              the paid features may be paused until the payment is made good.
            </li>
            <li>
              <strong>Price changes.</strong> We may change our prices. A
              change applies from your next renewal after we have told you
              about it.
            </li>
          </ul>
        </section>

        <section id="cancellation" className={styles.section}>
          <span className={styles.sectionNum}>06</span>
          <h2 className={styles.sectionTitle}>Cancellation &amp; Refunds</h2>
          <ul>
            <li>
              <strong>Cancel anytime.</strong> The company owner can cancel the
              subscription at any time from Settings &rarr; Billing.
              Cancellation stops future renewals. You keep access until the
              end of the period you have already paid for.
            </li>
            <li>
              <strong>No refunds.</strong> Payments already made are not
              refunded, whether for a monthly plan or a yearly plan, and we do
              not give partial refunds for unused time or unused seats.
            </li>
            <li>
              <strong>After cancellation.</strong> When the paid period ends,
              CRM access is paused. You may ask us to delete your data as
              described in our Privacy Policy.
            </li>
          </ul>
        </section>

        <section id="meta" className={styles.section}>
          <span className={styles.sectionNum}>07</span>
          <h2 className={styles.sectionTitle}>Meta (Facebook) Integration</h2>
          <ul>
            <li>
              <strong>Your own accounts only.</strong> You may connect only
              Facebook Pages and ad accounts that you own or are authorized to
              manage.
            </li>
            <li>
              <strong>Meta&apos;s terms apply.</strong> Your use of Meta
              features is also governed by Meta&apos;s own terms and policies,
              including the Meta Platform Terms. If Meta changes, limits, or
              withdraws access, parts of the Service may stop working. We are
              not responsible for Meta&apos;s actions or availability.
            </li>
            <li>
              <strong>Not affiliated with Meta.</strong> AgentzPro CRM is an
              independent product and is not endorsed by or affiliated with
              Meta Platforms, Inc.
            </li>
            <li>
              <strong>Disconnecting.</strong> You can disconnect your Meta
              connection at any time, and you can also remove our app from
              your Facebook account settings.
            </li>
          </ul>
        </section>

        <section id="your-data" className={styles.section}>
          <span className={styles.sectionNum}>08</span>
          <h2 className={styles.sectionTitle}>Your Data &amp; Leads</h2>
          <ul>
            <li>
              <strong>You own your data.</strong> You keep ownership of the
              lead data, notes, and other content your company puts into the
              Service. You give us permission to store and process it only to
              provide the Service to you, as described in our Privacy Policy.
            </li>
            <li>
              <strong>Your responsibility to leads.</strong> You are
              responsible for having a lawful basis to contact the people who
              submit your lead forms, and for following the laws that apply to
              your calls, messages, and emails to them, including consent and
              do-not-disturb rules.
            </li>
            <li>
              <strong>We do not sell your data</strong>, and we never show one
              company&apos;s data to another company.
            </li>
            <li>
              <strong>Deletion.</strong> You can delete lead records inside the
              CRM, and you can ask us to delete your data by contacting us.
              Deleted data cannot be recovered.
            </li>
          </ul>
        </section>

        <section id="acceptable-use" className={styles.section}>
          <span className={styles.sectionNum}>09</span>
          <h2 className={styles.sectionTitle}>Acceptable Use</h2>
          <p>You agree not to:</p>
          <ul>
            <li>use the Service for anything unlawful, fraudulent, or abusive;</li>
            <li>
              send spam, or harass, threaten, or deceive the people whose
              details you store;
            </li>
            <li>
              try to access another company&apos;s data, or probe, scan, or
              break the security of the Service;
            </li>
            <li>
              upload malware, or interfere with or overload the Service;
            </li>
            <li>
              copy, resell, or reverse engineer the Service, or use it to
              build a competing product; or
            </li>
            <li>
              share one login among several people to avoid paying for seats.
            </li>
          </ul>
        </section>

        <section id="suspension" className={styles.section}>
          <span className={styles.sectionNum}>10</span>
          <h2 className={styles.sectionTitle}>Suspension &amp; Termination</h2>
          <p>
            We may suspend or end your access if you break these Terms, if a
            payment is not made, if your use puts the Service or other
            customers at risk, or if we are required to by law. You may stop
            using the Service and close your account at any time by
            contacting us. Sections that by their nature should continue
            (including payments owed, liability, and governing law) continue
            after termination.
          </p>
        </section>

        <section id="availability" className={styles.section}>
          <span className={styles.sectionNum}>11</span>
          <h2 className={styles.sectionTitle}>
            Service Availability &amp; Changes
          </h2>
          <p>
            We work to keep the Service running, but we do not promise it will
            be uninterrupted or error free. It may be unavailable for
            maintenance, or because of problems with our providers, the
            internet, or Meta. We may update, change, or discontinue features,
            and we will try to give reasonable notice of any major change.
          </p>
        </section>

        <section id="disclaimer" className={styles.section}>
          <span className={styles.sectionNum}>12</span>
          <h2 className={styles.sectionTitle}>Disclaimer of Warranties</h2>
          <p>
            The Service is provided &quot;as is&quot; and &quot;as
            available&quot;. To the fullest extent permitted by law, we do not
            give any warranty, express or implied, including any warranty of
            fitness for a particular purpose. We do not guarantee that you
            will receive any particular number of leads, or that every lead
            from Meta will be delivered, because lead delivery depends on Meta
            and on your own ads and settings.
          </p>
        </section>

        <section id="liability" className={styles.section}>
          <span className={styles.sectionNum}>13</span>
          <h2 className={styles.sectionTitle}>Limitation of Liability</h2>
          <p>
            To the fullest extent permitted by law, AI Digital Tamizha is not
            liable for any indirect, incidental, special, or consequential
            loss, or for lost profits, lost leads, lost sales, or lost data,
            arising from your use of the Service. Our total liability to you
            for any claim relating to the Service is limited to the amount you
            paid us for the Service in the three (3) months before the event
            that gave rise to the claim. Nothing in these Terms limits any
            liability that cannot be limited under applicable law.
          </p>
        </section>

        <section id="governing-law" className={styles.section}>
          <span className={styles.sectionNum}>14</span>
          <h2 className={styles.sectionTitle}>Governing Law</h2>
          <p>
            These Terms are governed by the laws of India. Any dispute arising
            from them or from the Service is subject to the exclusive
            jurisdiction of the courts at Chennai, Tamil Nadu, India.
          </p>
        </section>

        <section id="changes" className={styles.section}>
          <span className={styles.sectionNum}>15</span>
          <h2 className={styles.sectionTitle}>Changes to These Terms</h2>
          <p>
            We may update these Terms from time to time. When we do, we will
            change the &quot;Last Updated&quot; date at the top of this page.
            If you keep using the Service after a change takes effect, you
            accept the updated Terms. If you do not agree, you should stop
            using the Service.
          </p>
        </section>

        <section id="contact" className={styles.section}>
          <span className={styles.sectionNum}>16</span>
          <h2 className={styles.sectionTitle}>Contact Us</h2>
          <p>
            If you have any questions about these Terms, please contact us:
          </p>
          <div className={styles.contactCard}>
            <div className={styles.contactGrid}>
              <div className={styles.contactItem}>
                <span className={styles.contactLabel}>Business</span>
                <span className={styles.contactValue}>AI Digital Tamizha</span>
              </div>
              <div className={styles.contactItem}>
                <span className={styles.contactLabel}>Email</span>
                <a
                  className={`${styles.contactValue} ${styles.link}`}
                  href="mailto:aidigitaltamizha@gmail.com"
                >
                  aidigitaltamizha@gmail.com
                </a>
              </div>
              <div className={styles.contactItem}>
                <span className={styles.contactLabel}>Phone Number</span>
                <a
                  className={`${styles.contactValue} ${styles.link}`}
                  href="tel:+919047227223"
                >
                  +91 90472 27223
                </a>
              </div>
              <div className={styles.contactItem}>
                <span className={styles.contactLabel}>Location</span>
                <span className={styles.contactValue}>
                  Lakshmi Nagar, Mudichur, Chennai 600028, Tamil Nadu, India
                </span>
              </div>
            </div>
          </div>
        </section>

        <a href="#top" className={styles.backToTop}>
          &uarr; Back to top
        </a>
      </main>
      <SiteFooter />
    </>
  );
}

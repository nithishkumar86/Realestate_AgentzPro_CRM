import Link from "next/link";
import type { Metadata } from "next";
import styles from "./privacy-policy.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy | AgentzPro CRM",
  description:
    "Privacy Policy for AgentzPro CRM, operated by AI Digital Tamizha. Learn what data we collect, how we use it, and how to request deletion of your data.",
};

const EFFECTIVE_DATE = "September 14, 2026";

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
          <a href="mailto:aidigitaltamizha@gmail.com">
            Contact Us
          </a>
        </nav>
      </div>
    </footer>
  );
}

const TOC = [
  ["who-we-are", "1. Who We Are (Data Controller)"],
  ["scope", "2. Scope of This Policy"],
  ["information-we-collect", "3. Information We Collect"],
  ["how-we-use", "4. How We Use Your Information"],
  ["data-sharing", "5. How We Share Information"],
  ["tenant-isolation", "6. Multi-Tenant Data Isolation"],
  ["retention", "7. Data Retention"],
  ["security", "8. Data Security"],
  ["your-rights", "9. Your Rights & Data Deletion"],
  ["cookies", "10. Cookies & Tracking"],
  ["children", "11. Children's Privacy"],
  ["governing-law", "12. Governing Law"],
  ["changes", "13. Changes to This Policy"],
  ["contact", "14. Contact Us"],
] as const;

export default function PrivacyPolicyPage() {
  return (
    <>
      <SiteHeader />
      <main id="top" className={`${styles.container} ${styles.policyWrap}`}>
        <div className={styles.policyHeader}>
          <span className={styles.policyBadge}>Privacy Policy</span>
          <h1 className={styles.policyTitle}>AgentzPro CRM Privacy Policy</h1>
          <p className={styles.policyMeta}>
            Effective Date: {EFFECTIVE_DATE} &middot; Last Updated:{" "}
            {EFFECTIVE_DATE}
          </p>
          <p className={styles.policyIntro}>
            This Privacy Policy explains how <strong>AI Digital Tamizha</strong>{" "}
            (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) collects, uses,
            discloses, and protects information in connection with{" "}
            <strong>AgentzPro CRM</strong> (the &quot;Service&quot;), our
            multi-tenant, business-to-business customer relationship
            management platform that integrates with Meta (Facebook) to help
            our clients capture and manage leads. This is our own Privacy
            Policy for our own product; it is not the privacy policy of any
            other company. By using the Service, you agree to the practices
            described in this Privacy Policy.
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

        <section id="who-we-are" className={styles.section}>
          <span className={styles.sectionNum}>01</span>
          <h2 className={styles.sectionTitle}>Who We Are (Data Controller)</h2>
          <p>
            AgentzPro CRM is owned and operated by AI Digital Tamizha, which
            acts as the data controller responsible for deciding why and how
            personal data is processed through the Service.
          </p>
          <table className={styles.infoTable}>
            <tbody>
              <tr>
                <th>Business Name</th>
                <td>AI Digital Tamizha</td>
              </tr>
              <tr>
                <th>Product / Service</th>
                <td>AgentzPro CRM</td>
              </tr>
              <tr>
                <th>Nature of Work</th>
                <td>Product selling</td>
              </tr>
              <tr>
                <th>Registered Location</th>
                <td>Lakshmi Nagar, Mudichur, Chennai 600028, Tamil Nadu, India</td>
              </tr>
              <tr>
                <th>Contact Email</th>
                <td>aidigitaltamizha@gmail.com</td>
              </tr>
              <tr>
                <th>Phone Number</th>
                <td>+91 90472 27223</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section id="scope" className={styles.section}>
          <span className={styles.sectionNum}>02</span>
          <h2 className={styles.sectionTitle}>Scope of This Policy</h2>
          <p>
            AgentzPro CRM is a <strong>multi-tenant SaaS platform</strong>.
            Multiple independent client businesses (&quot;tenants&quot;) use
            the Service under their own separate accounts, and each tenant may
            connect their own Facebook account and Facebook Page(s) to the
            Service to receive leads generated through Meta Lead Ads. Every
            tenant&apos;s data is logically separated and access-controlled so
            that one tenant can never view, access, or receive another
            tenant&apos;s data. This Privacy Policy applies to all data
            processed through AgentzPro CRM, including data belonging to
            tenant businesses and data belonging to the end-customers
            (&quot;leads&quot;) who submit their information through those
            tenants&apos; Facebook Lead Ads.
          </p>
        </section>

        <section id="information-we-collect" className={styles.section}>
          <span className={styles.sectionNum}>03</span>
          <h2 className={styles.sectionTitle}>Information We Collect</h2>

          <h3 className={styles.subheading}>
            3.1 Information You Provide Directly
          </h3>
          <p>
            When a business signs up to use AgentzPro CRM, we collect account
            information such as the tenant&apos;s business name, the name and
            email address of the people who create and manage the account,
            and login credentials.
          </p>

          <h3 className={styles.subheading}>
            3.2 Information Collected via Facebook Login
          </h3>
          <p>
            When a tenant connects their Facebook account to AgentzPro CRM
            using Facebook Login, we receive basic profile information made
            available through that login, such as the user&apos;s name, email
            address, and Facebook user ID. This is used solely to
            authenticate the tenant and establish their connection to Meta on
            their own behalf.
          </p>

          <h3 className={styles.subheading}>
            3.3 Information Collected via Connected Facebook Pages
          </h3>
          <p>
            Once a tenant authorizes AgentzPro CRM to connect to one or more
            of their Facebook Pages, we collect and securely store the Page
            ID, Page name, and the Page access token required to receive
            leads on that tenant&apos;s behalf. Access tokens are used only
            to retrieve lead data for the tenant that authorized the
            connection and are never used to access any other tenant&apos;s
            Pages.
          </p>

          <h3 className={styles.subheading}>
            3.4 Lead Data Collected via Meta Lead Ads
          </h3>
          <p>
            When an end-customer submits a Meta (Facebook) Lead Ads form on a
            tenant&apos;s connected Facebook Page, Meta sends that submission
            to AgentzPro CRM through Meta&apos;s webhook and Graph API. This
            lead data may include the submitter&apos;s name, email address,
            phone number, and answers to any custom questions included in the
            lead form, along with metadata identifying the campaign ID, ad set
            ID, ad ID, and lead form ID associated with the submission. This
            data is delivered only to the specific tenant who owns the
            connected Facebook Page and ad.
          </p>

          <h3 className={styles.subheading}>
            3.5 Information Collected Automatically
          </h3>
          <p>
            Like most web applications, when you visit our website or use the
            Service we may automatically collect certain technical
            information, including browser type, device information, IP
            address, server logs, and general usage information (such as
            pages visited and actions taken within the CRM). This information
            is used to operate, secure, and improve the Service.
          </p>
        </section>

        <section id="how-we-use" className={styles.section}>
          <span className={styles.sectionNum}>04</span>
          <h2 className={styles.sectionTitle}>How We Use Your Information</h2>
          <p>We process the information described above to:</p>
          <ul>
            <li>
              Provide, operate, and maintain AgentzPro CRM for each tenant,
              including authenticating tenants and connecting their Facebook
              Pages;
            </li>
            <li>
              Receive, display, organize, and allow tenants to manage and
              respond to leads generated from their own Meta Lead Ads;
            </li>
            <li>
              Recognize a returning tenant user and keep their account
              session secure;
            </li>
            <li>
              Monitor, secure, diagnose, and improve the reliability and
              performance of the Service;
            </li>
            <li>
              Communicate with tenants about their account, support requests,
              or material changes to the Service; and
            </li>
            <li>
              Comply with applicable legal obligations and enforce our terms.
            </li>
          </ul>
          <p>
            <strong>
              We do not use a client&apos;s lead data for any purpose other
              than providing that client&apos;s own CRM services.
            </strong>{" "}
            We do not use lead data to market to leads on our own behalf, and
            we do not sell lead data or tenant data to any third party.
          </p>
        </section>

        <section id="data-sharing" className={styles.section}>
          <span className={styles.sectionNum}>05</span>
          <h2 className={styles.sectionTitle}>How We Share Information</h2>
          <p>
            We do not sell personal data. We only share information in the
            following limited circumstances:
          </p>
          <ul>
            <li>
              <strong>With Meta Platforms, Inc.</strong> — to the extent
              necessary to authenticate a tenant&apos;s Facebook account,
              retrieve leads from their connected Facebook Pages, and comply
              with Meta&apos;s Platform Terms;
            </li>
            <li>
              <strong>With infrastructure service providers</strong> who
              process data strictly on our behalf and under our instructions
              to operate the Service, namely our database provider (Supabase,
              for secure data storage) and our hosting provider (Render, for
              running the application);
            </li>
            <li>
              <strong>For legal reasons</strong> — where required to comply
              with a legal obligation, protect the rights, property, or
              safety of AI Digital Tamizha, our tenants, or others.
            </li>
          </ul>
          <p>
            We do not share one tenant&apos;s data with any other tenant, and
            we do not share lead data with any party for advertising or
            marketing purposes.
          </p>
        </section>

        <section id="tenant-isolation" className={styles.section}>
          <span className={styles.sectionNum}>06</span>
          <h2 className={styles.sectionTitle}>Multi-Tenant Data Isolation</h2>
          <p>
            AgentzPro CRM is architected so that every record is scoped to
            the specific tenant it belongs to, with database-level access
            controls (row-level security tied to a unique tenant identifier)
            enforced on every request. This is designed to ensure that no
            tenant can query, view, export, or otherwise access another
            tenant&apos;s Facebook connections, leads, or account data under
            any circumstance.
          </p>
        </section>

        <section id="retention" className={styles.section}>
          <span className={styles.sectionNum}>07</span>
          <h2 className={styles.sectionTitle}>Data Retention</h2>
          <p>
            We retain tenant account data and lead data for as long as the
            tenant&apos;s account with AgentzPro CRM remains active, in order
            to continue providing the Service. If a tenant closes their
            account, or if a deletion request is made as described in Section
            9 below, we will delete the corresponding data, except where we
            are required to retain limited information to comply with a legal
            obligation, resolve disputes, or enforce our agreements.
          </p>
        </section>

        <section id="security" className={styles.section}>
          <span className={styles.sectionNum}>08</span>
          <h2 className={styles.sectionTitle}>Data Security</h2>
          <p>
            We apply technical and organizational measures designed to
            protect the information in our care, including encrypted storage
            of Facebook access tokens, verified webhook signatures for
            incoming lead data from Meta, encrypted connections (HTTPS) for
            all data in transit, and tenant-isolated database access controls
            as described in Section 6. While no system can be guaranteed
            100% secure, we work to protect your information using
            industry-standard practices.
          </p>
        </section>

        <section id="your-rights" className={styles.section}>
          <span className={styles.sectionNum}>09</span>
          <h2 className={styles.sectionTitle}>Your Rights &amp; Data Deletion</h2>
          <p>
            Tenants and leads whose data is processed through AgentzPro CRM
            have the right to request access to, correction of, or deletion
            of their personal data.
          </p>
          <ul>
            <li>
              <strong>Tenants</strong> can delete lead records directly within
              the AgentzPro CRM application using the built-in delete
              function.
            </li>
            <li>
              <strong>Anyone</strong> — including a tenant wishing to close
              their account entirely, or an individual lead who wants their
              data removed — can request deletion by contacting us directly
              using the details in Section 14 (Contact Us).
            </li>
          </ul>
          <p>
            Once a deletion request is verified, we will delete the requested
            data from our systems, except where retention is required by law.
            Please note that once data is deleted, we are not able to recover
            it.
          </p>
        </section>

        <section id="cookies" className={styles.section}>
          <span className={styles.sectionNum}>10</span>
          <h2 className={styles.sectionTitle}>Cookies &amp; Tracking Technologies</h2>
          <p>
            This website and AgentzPro CRM do not use third-party advertising
            or analytics cookies. We use only essential cookies required to
            keep a tenant securely signed in to their CRM account session.
            These essential cookies do not track you across other websites.
          </p>
        </section>

        <section id="children" className={styles.section}>
          <span className={styles.sectionNum}>11</span>
          <h2 className={styles.sectionTitle}>Children&apos;s Privacy</h2>
          <p>
            AgentzPro CRM is a business-to-business product intended for use
            by business owners and their staff. It is not directed at, and we
            do not knowingly collect personal data from, children. If you
            believe a child has provided us with personal data, please
            contact us so we can delete it.
          </p>
        </section>

        <section id="governing-law" className={styles.section}>
          <span className={styles.sectionNum}>12</span>
          <h2 className={styles.sectionTitle}>Governing Law</h2>
          <p>
            AI Digital Tamizha is based in Chennai, Tamil Nadu, India, and we
            process personal data in accordance with applicable Indian law,
            including the Digital Personal Data Protection Act, 2023. This
            Privacy Policy, and any dispute arising from it, is governed by
            the laws of India.
          </p>
        </section>

        <section id="changes" className={styles.section}>
          <span className={styles.sectionNum}>13</span>
          <h2 className={styles.sectionTitle}>Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time to reflect
            changes in our practices or for legal or operational reasons. We
            will update the &quot;Last Updated&quot; date at the top of this
            page when we make changes. We encourage you to review this page
            periodically.
          </p>
        </section>

        <section id="contact" className={styles.section}>
          <span className={styles.sectionNum}>14</span>
          <h2 className={styles.sectionTitle}>Contact Us</h2>
          <p>
            If you have any questions, concerns, or requests regarding this
            Privacy Policy or the handling of your personal data — including
            requests to delete your data — please contact us:
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

import Link from "next/link";
import type { Metadata } from "next";
import styles from "./privacy-policy.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy | AgentzPro CRM",
  description:
    "Privacy Policy for AgentzPro CRM, operated by AI Digital Tamizha. Learn what data we collect from Meta and Google Ads, how we use it, and how to request deletion of your data.",
};

const EFFECTIVE_DATE = "September 14, 2026";
const LAST_UPDATED = "October 27, 2026";
const GOOGLE_USER_DATA_POLICY_URL =
  "https://developers.google.com/terms/api-services-user-data-policy";

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
          <Link href="/contact">Contact Us</Link>
          <Link href="/terms">Terms of Service</Link>
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
  ["google-user-data", "6. Google User Data & Limited Use"],
  ["tenant-isolation", "7. Multi-Tenant Data Isolation"],
  ["retention", "8. Data Retention"],
  ["security", "9. Data Security"],
  ["your-rights", "10. Your Rights & Data Deletion"],
  ["cookies", "11. Cookies & Tracking"],
  ["children", "12. Children's Privacy"],
  ["payments", "13. Payments, Cancellation & Refunds"],
  ["governing-law", "14. Governing Law"],
  ["changes", "15. Changes to This Policy"],
  ["contact", "16. Contact Us"],
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
            {LAST_UPDATED}
          </p>
          <p className={styles.policyIntro}>
            This Privacy Policy explains how <strong>AI Digital Tamizha</strong>{" "}
            (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) collects, uses,
            discloses, and protects information in connection with{" "}
            <strong>AgentzPro CRM</strong> (the &quot;Service&quot;), our
            multi-tenant, business-to-business customer relationship
            management platform that integrates with Meta (Facebook) and
            Google Ads to help our clients capture and manage leads. This is our own Privacy
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
            Service to receive leads generated through Meta Lead Ads. A
            tenant may also connect their own Google Ads account(s), using
            Google Sign-In, to receive leads generated through Google Ads lead
            forms. Every tenant&apos;s data is logically separated and
            access-controlled so that one tenant can never view, access, or
            receive another tenant&apos;s data. This Privacy Policy applies to
            all data processed through AgentzPro CRM, including data belonging
            to tenant businesses and data belonging to the end-customers
            (&quot;leads&quot;) who submit their information through those
            tenants&apos; Facebook Lead Ads or Google Ads lead forms.
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
            3.5 Information Collected via Google Sign-In and Google Ads
          </h3>
          <p>
            When a tenant connects their Google Ads account to AgentzPro CRM,
            they sign in with Google and are shown Google&apos;s consent screen
            listing the access we request. With the tenant&apos;s permission,
            we receive:
          </p>
          <ul>
            <li>
              <strong>Basic Google account information</strong> — the name,
              email address, and Google account ID of the person who
              connected, so the tenant can see which Google account is linked;
            </li>
            <li>
              <strong>Google Ads account information</strong> — the IDs and
              names of the Google Ads accounts that person can access and
              chooses to connect, and the IDs and names of their campaigns, ad
              groups, ads, and lead forms, so each lead can show which ad it
              came from; and
            </li>
            <li>
              <strong>Google OAuth tokens</strong> — the access token and
              refresh token Google issues for that connection, which we store
              encrypted and use only to read that tenant&apos;s own Google Ads
              data.
            </li>
          </ul>
          <p>
            We only read this data. We do not create, edit, pause, or delete
            campaigns or ads, and we do not change budgets, bids, or billing in
            any Google Ads account.
          </p>

          <h3 className={styles.subheading}>
            3.6 Lead Data Collected via Google Ads Lead Forms
          </h3>
          <p>
            When an end-customer submits a Google Ads lead form on a
            tenant&apos;s ad, Google sends that submission to AgentzPro CRM
            through the lead form webhook the tenant has set up. This lead
            data may include the submitter&apos;s name, email address, phone
            number, and answers to any other questions included in the lead
            form, along with metadata such as the lead ID, form ID, campaign
            ID, ad group ID, ad ID, and Google click ID (GCLID). Each webhook
            is protected by a secret key unique to the tenant, and the data is
            delivered only to the tenant who owns that Google Ads account and
            ad.
          </p>

          <h3 className={styles.subheading}>
            3.7 Information Collected Automatically
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
              Pages and Google Ads accounts;
            </li>
            <li>
              Receive, display, organize, and allow tenants to manage and
              respond to leads generated from their own Meta Lead Ads and
              Google Ads lead forms;
            </li>
            <li>
              Give each lead an AI lead label (Hot, Warm, or Cold) shown to the
              tenant in their CRM, to help them decide which leads to contact
              first. Before a lead is sent for labelling, we remove the
              lead&apos;s name, email address, and phone number, as described
              in Section 5;
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
              <strong>With Google LLC</strong> — to the extent necessary to
              authenticate a tenant&apos;s Google account, read their connected
              Google Ads account data, receive leads from their Google Ads lead
              forms, and comply with Google&apos;s terms and policies;
            </li>
            <li>
              <strong>With service providers</strong> who process data strictly
              on our behalf and under our instructions to operate the Service:
              <ul>
                <li>
                  <strong>Supabase</strong> — our database provider, for secure
                  data storage;
                </li>
                <li>
                  <strong>Vercel</strong> — our hosting provider, for running
                  the application;
                </li>
                <li>
                  <strong>Upstash</strong> — for queuing incoming leads so none
                  are lost, and for rate limiting;
                </li>
                <li>
                  <strong>Resend</strong> — for sending account emails, such as
                  invitations to join a tenant&apos;s team;
                </li>
                <li>
                  <strong>Cloudflare Turnstile</strong> — for checking that a
                  sign-in comes from a real person and not a bot;
                </li>
                <li>
                  <strong>Razorpay</strong> — for processing subscription
                  payments (see Section 13); and
                </li>
                <li>
                  <strong>Portkey</strong> — an AI gateway that passes a lead to
                  an AI model provider to produce the AI lead label described
                  in Section 4. Before anything is sent, we replace the
                  lead&apos;s name, email address, and phone number with
                  placeholders (such as [NAME], [EMAIL], and [PHONE]),
                  including anywhere those same details are repeated inside
                  other answers. Only the remaining form answers, the ad name,
                  and the lead&apos;s current status are sent. The resulting
                  label is shown only to the tenant who owns that lead;
                </li>
              </ul>
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

        <section id="google-user-data" className={styles.section}>
          <span className={styles.sectionNum}>06</span>
          <h2 className={styles.sectionTitle}>
            Google User Data &amp; Limited Use
          </h2>
          <p>
            <strong>
              AgentzPro CRM&apos;s use and transfer to any other app of
              information received from Google APIs will adhere to the{" "}
              <a
                className={styles.link}
                href={GOOGLE_USER_DATA_POLICY_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </strong>
          </p>

          <h3 className={styles.subheading}>6.1 What Google Data We Access</h3>
          <p>
            We request only the Google permissions needed for the Google Ads
            features of AgentzPro CRM, and we ask for them only when a tenant
            chooses to connect Google Ads:
          </p>
          <ul>
            <li>
              <strong>Google Sign-In (openid, email, profile)</strong> — to
              identify the Google account that was connected;
            </li>
            <li>
              <strong>
                Google Ads API (https://www.googleapis.com/auth/adwords)
              </strong>{" "}
              — to read the tenant&apos;s Google Ads accounts, campaigns, ad
              groups, ads, and lead forms, as described in Section 3.5.
            </li>
          </ul>

          <h3 className={styles.subheading}>6.2 How We Use Google Data</h3>
          <p>
            We use Google user data only to provide the user-facing features
            of AgentzPro CRM that the tenant can see in the app: linking their
            Google Ads account, receiving their Google Ads leads, showing which
            campaign and ad each lead came from, and producing the AI lead
            label described in Section 4.
          </p>

          <h3 className={styles.subheading}>6.3 What We Never Do</h3>
          <ul>
            <li>We never sell Google user data.</li>
            <li>
              We never transfer Google user data to advertising platforms, data
              brokers, or other information resellers.
            </li>
            <li>
              We never use Google user data to serve ads, including
              retargeting, personalised, or interest-based advertising.
            </li>
            <li>
              We never use Google user data to determine credit-worthiness or
              for lending purposes.
            </li>
            <li>
              We never use Google user data to develop, improve, or train
              generalised artificial intelligence or machine-learning models.
            </li>
          </ul>
          <p>
            We transfer Google user data only to the service providers listed
            in Section 5, only to run the features above, and otherwise only
            for security purposes (for example, investigating abuse), to comply
            with applicable law, or as part of a merger, acquisition, or sale
            of assets after obtaining the user&apos;s explicit prior consent.
          </p>

          <h3 className={styles.subheading}>6.4 Who Can See Google Data</h3>
          <p>
            Google Ads leads and account data are shown only to the users of
            the tenant that connected the Google Ads account. Our own staff do
            not read Google user data unless (a) the tenant has given us
            permission to view specific data, for example to help with a
            support request; (b) it is necessary for security purposes, such
            as investigating a bug or abuse; (c) it is necessary to comply with
            applicable law; or (d) the data is aggregated and used for internal
            operations in line with applicable law.
          </p>

          <h3 className={styles.subheading}>
            6.5 Disconnecting Google &amp; Revoking Access
          </h3>
          <p>
            A tenant can disconnect Google Ads at any time from within
            AgentzPro CRM. When they do, we revoke our access with Google and
            delete the stored Google OAuth tokens, and we stop receiving new
            data from that Google Ads account. Access can also be removed at
            any time from the Google Account permissions page at{" "}
            <a
              className={styles.link}
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noopener noreferrer"
            >
              myaccount.google.com/permissions
            </a>
            . Leads that were already received stay in the tenant&apos;s CRM
            until the tenant deletes them or asks us to delete them, as
            described in Section 10.
          </p>
        </section>

        <section id="tenant-isolation" className={styles.section}>
          <span className={styles.sectionNum}>07</span>
          <h2 className={styles.sectionTitle}>Multi-Tenant Data Isolation</h2>
          <p>
            AgentzPro CRM is architected so that every record is scoped to
            the specific tenant it belongs to, with database-level access
            controls (row-level security tied to a unique tenant identifier)
            enforced on every request. This is designed to ensure that no
            tenant can query, view, export, or otherwise access another
            tenant&apos;s Facebook connections, Google Ads connections, leads,
            or account data under any circumstance.
          </p>
        </section>

        <section id="retention" className={styles.section}>
          <span className={styles.sectionNum}>08</span>
          <h2 className={styles.sectionTitle}>Data Retention</h2>
          <p>
            We retain tenant account data and lead data for as long as the
            tenant&apos;s account with AgentzPro CRM remains active, in order
            to continue providing the Service. If a tenant closes their
            account, or if a deletion request is made as described in Section
            10 below, we will delete the corresponding data, except where we
            are required to retain limited information to comply with a legal
            obligation, resolve disputes, or enforce our agreements. Google
            OAuth tokens are kept only while the Google Ads connection is
            active and are deleted when the tenant disconnects Google Ads, as
            described in Section 6.5.
          </p>
        </section>

        <section id="security" className={styles.section}>
          <span className={styles.sectionNum}>09</span>
          <h2 className={styles.sectionTitle}>Data Security</h2>
          <p>
            We apply technical and organizational measures designed to
            protect the information in our care, including encrypted storage
            of Facebook access tokens and Google OAuth tokens, verified
            webhook signatures for incoming lead data from Meta, a secret key
            check on every incoming Google Ads lead form webhook, encrypted
            connections (HTTPS) for all data in transit, and tenant-isolated
            database access controls as described in Section 7. While no system can be guaranteed
            100% secure, we work to protect your information using
            industry-standard practices.
          </p>
        </section>

        <section id="your-rights" className={styles.section}>
          <span className={styles.sectionNum}>10</span>
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
              using the details in Section 16 (Contact Us).
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
          <span className={styles.sectionNum}>11</span>
          <h2 className={styles.sectionTitle}>Cookies &amp; Tracking Technologies</h2>
          <p>
            This website and AgentzPro CRM do not use third-party advertising
            or analytics cookies. We use only essential cookies required to
            keep a tenant securely signed in to their CRM account session.
            These essential cookies do not track you across other websites.
          </p>
        </section>

        <section id="children" className={styles.section}>
          <span className={styles.sectionNum}>12</span>
          <h2 className={styles.sectionTitle}>Children&apos;s Privacy</h2>
          <p>
            AgentzPro CRM is a business-to-business product intended for use
            by business owners and their staff. It is not directed at, and we
            do not knowingly collect personal data from, children. If you
            believe a child has provided us with personal data, please
            contact us so we can delete it.
          </p>
        </section>

        <section id="payments" className={styles.section}>
          <span className={styles.sectionNum}>13</span>
          <h2 className={styles.sectionTitle}>
            Payments, Cancellation &amp; Refunds
          </h2>
          <p>
            Paid plans for AgentzPro CRM are billed per seat, monthly or
            yearly, and payments are processed securely by our payment
            partner, Razorpay.
          </p>
          <ul>
            <li>
              <strong>Cancel anytime.</strong> Once a payment is made, you can
              cancel your subscription at any time — it is entirely your
              choice. Cancellation stops future renewals, and you keep access
              until the end of the period you have already paid for.
            </li>
            <li>
              <strong>No refunds.</strong> Payments already made are not
              refunded, whether for a monthly plan or a yearly plan.
            </li>
          </ul>
        </section>

        <section id="governing-law" className={styles.section}>
          <span className={styles.sectionNum}>14</span>
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
          <span className={styles.sectionNum}>15</span>
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
          <span className={styles.sectionNum}>16</span>
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

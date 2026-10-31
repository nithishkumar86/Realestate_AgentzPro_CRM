import Link from "next/link";
import type { Metadata } from "next";
import { ArrowUp, CheckCircle2 } from "lucide-react";
import { PublicSiteFooter, PublicSiteHeader } from "@/components/public-site-chrome";
import { LegalDocToc, LegalDocTocMobile } from "@/components/legal-doc-toc";
import landing from "../landing.module.css";
import styles from "./privacy-policy.module.css";

export const metadata: Metadata = {
  title: { absolute: "Privacy Policy | AgentzPro" },
  description:
    "Privacy Policy for AgentzPro, operated by AI Digital Tamizha: what data we collect from Meta, Google Ads and your team, how we use, store, share and protect it, how Google user data is handled under the Limited Use requirements, and how to delete your data.",
};

const EFFECTIVE_DATE = "September 14, 2026";
const LAST_UPDATED = "October 31, 2026";
const GOOGLE_USER_DATA_POLICY_URL = "https://developers.google.com/terms/api-services-user-data-policy";

const TOC = [
  ["who-we-are", "1. Who we are"],
  ["scope", "2. Scope of this policy"],
  ["information-we-collect", "3. Information we collect"],
  ["how-we-use", "4. How we use information"],
  ["data-sharing", "5. How we share information"],
  ["google-user-data", "6. Google user data and Limited Use"],
  ["tenant-isolation", "7. Each company's data is separate"],
  ["retention", "8. Data retention"],
  ["security", "9. Data security"],
  ["your-rights", "10. Your rights and deleting your data"],
  ["cookies", "11. Cookies and browser storage"],
  ["children", "12. Children's privacy"],
  ["payments", "13. Payments, cancellation and refunds"],
  ["governing-law", "14. Governing law"],
  ["changes", "15. Changes to this policy"],
  ["contact", "16. Contact us"],
] as const;

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <div className={landing.page}>
      <PublicSiteHeader />
      <main id="top" className={`${styles.container} ${styles.policyWrap}`}>
        <div className={styles.policyHeader}>
          <span className={styles.policyBadge}>Privacy Policy</span>
          <h1 className={styles.policyTitle}>AgentzPro Privacy Policy</h1>
          <p className={styles.policyMeta}>
            <span>Effective date: {EFFECTIVE_DATE}</span>
            <span>Last updated: {LAST_UPDATED}</span>
          </p>
          <p className={styles.policyIntro}>
            This Privacy Policy explains how <strong>AI Digital Tamizha</strong> (&quot;we&quot;, &quot;us&quot; or
            &quot;our&quot;) collects, uses, stores, shares and protects information in connection with{" "}
            <strong>AgentzPro</strong> (the &quot;Service&quot;), our multi-tenant, business-to-business lead
            management CRM. AgentzPro receives leads from our customers&apos; Meta (Facebook and Instagram) Lead Ads and
            Google Ads lead forms, and lets their teams manage and follow up on those leads. This is our own privacy
            policy for our own product. By using the Service, you agree to the practices described here.
          </p>
        </div>

        <div className={styles.layout}>
          <LegalDocToc entries={TOC} />

          <article className={styles.doc}>
            <LegalDocTocMobile entries={TOC} />

            <div className={styles.summary}>
              <h2 className={styles.summaryTitle}>At a glance</h2>
              <ul className={styles.summaryGrid}>
                <li className={styles.summaryItem}>
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <span><strong>We never sell your data.</strong> Not lead data, not account data, not Google data.</span>
                </li>
                <li className={styles.summaryItem}>
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <span>
                    <strong>Google data follows Limited Use.</strong> It is used only for the features you see in the
                    app, and never for advertising or to train AI models.
                  </span>
                </li>
                <li className={styles.summaryItem}>
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <span>
                    <strong>We only read your Google Ads.</strong> We never change campaigns, budgets, bids or billing.
                  </span>
                </li>
                <li className={styles.summaryItem}>
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <span>
                    <strong>You stay in control.</strong> Disconnect Facebook or Google at any time, and ask us to delete
                    your data.
                  </span>
                </li>
              </ul>
            </div>

            <section id="who-we-are" className={styles.section}>
              <span className={styles.sectionNum}>01</span>
              <h2 className={styles.sectionTitle}>Who we are</h2>
              <p>
                AgentzPro is owned and operated by AI Digital Tamizha, which is responsible for deciding why and how
                personal data is processed through the Service.
              </p>
              <div className={styles.tableWrap}>
                <table className={styles.infoTable}>
                  <tbody>
                    <tr><th scope="row">Business name</th><td>AI Digital Tamizha</td></tr>
                    <tr><th scope="row">Product</th><td>AgentzPro</td></tr>
                    <tr><th scope="row">Nature of work</th><td>Software as a service (SaaS)</td></tr>
                    <tr><th scope="row">Registered location</th><td>Lakshmi Nagar, Mudichur, Chennai 600028, Tamil Nadu, India</td></tr>
                    <tr><th scope="row">Email</th><td>aidigitaltamizha@gmail.com</td></tr>
                    <tr><th scope="row">Phone</th><td>+91 90472 27223</td></tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section id="scope" className={styles.section}>
              <span className={styles.sectionNum}>02</span>
              <h2 className={styles.sectionTitle}>Scope of this policy</h2>
              <p>
                AgentzPro is a <strong>multi-tenant SaaS platform</strong>. Many independent businesses
                (&quot;companies&quot; or &quot;tenants&quot;) use the Service under their own separate accounts. Each
                company may connect its own Facebook Pages to receive Meta Lead Ads leads, connect its own Google Ads
                accounts with Google Sign-In, and set up its own Google Ads lead form webhook. Each company&apos;s data
                is kept separate, so one company can never see another company&apos;s data.
              </p>
              <p>
                This policy covers all data processed through AgentzPro: data about the companies and their team
                members, and data about the people (&quot;leads&quot;) who submit a company&apos;s Facebook or Google
                Ads lead forms or who call the company.
              </p>
            </section>

            <section id="information-we-collect" className={styles.section}>
              <span className={styles.sectionNum}>03</span>
              <h2 className={styles.sectionTitle}>Information we collect</h2>

              <h3 className={styles.subheading}>3.1 Account information</h3>
              <p>
                When a business signs up, we collect the company name and the name, email address and role of the owner
                and each team member they invite. You sign in with a one-time code sent to your email address, so we do
                not store passwords.
              </p>

              <h3 className={styles.subheading}>3.2 Facebook Login</h3>
              <p>
                When a company owner connects Facebook, we receive the basic profile information Facebook Login makes
                available, such as the person&apos;s name and Facebook user ID. We use it only to connect that
                company to Meta on its own behalf.
              </p>

              <h3 className={styles.subheading}>3.3 Connected Facebook Pages</h3>
              <p>
                When a company connects one or more of its Facebook Pages, we store the Page ID, the Page name and the
                Page access token needed to receive leads for that Page. Access tokens are stored encrypted and are used
                only to retrieve leads for the company that connected the Page.
              </p>

              <h3 className={styles.subheading}>3.4 Leads from Meta Lead Ads</h3>
              <p>
                When someone submits a Lead Ads form on a company&apos;s connected Facebook Page (including ads shown on
                Instagram), Meta sends the submission to AgentzPro through Meta&apos;s webhook and Graph API. It may
                include the person&apos;s name, email address, phone number and answers to the form&apos;s questions,
                together with the campaign, ad set, ad and form IDs and the ad name. This data is delivered only to the
                company that owns the Page and ad.
              </p>

              <h3 className={styles.subheading}>3.5 Google Sign-In and Google Ads</h3>
              <p>
                When a company owner connects Google Ads, they sign in with Google and see Google&apos;s consent screen
                listing the access we ask for. With their permission, we receive:
              </p>
              <ul>
                <li>
                  <strong>Basic Google account information:</strong> the email address and Google account ID of the
                  person who connected, so the company can see which Google account is linked;
                </li>
                <li>
                  <strong>Google Ads account information:</strong> the list of Google Ads accounts that person can
                  reach (including client accounts under a manager account) and their names, so the owner can choose
                  which accounts to link. We store only the accounts the owner chooses;
                </li>
                <li>
                  <strong>Campaign, ad group and asset group names:</strong> for each Google Ads lead, we look up the
                  names that match the IDs in the lead, so the lead shows which campaign it came from; and
                </li>
                <li>
                  <strong>A Google refresh token:</strong> the token Google issues for the connection, which we store
                  encrypted. Short-lived access tokens made from it are kept in memory only while a request runs and
                  are never saved.
                </li>
              </ul>
              <p>
                We only read this data. We never create, edit, pause or delete campaigns or ads, and we never change
                budgets, bids or billing in any Google Ads account.
              </p>

              <h3 className={styles.subheading}>3.6 Leads from Google Ads lead forms</h3>
              <p>
                When someone submits a Google Ads lead form, Google sends the submission to AgentzPro through the
                webhook the company owner has added to that form. It may include the person&apos;s name, email address,
                phone number and answers to the form&apos;s questions, together with the lead ID, form ID, campaign ID,
                ad group ID, ad ID and Google click ID (GCLID). Every webhook has a secret key unique to the company,
                and the data is delivered only to that company.
              </p>

              <h3 className={styles.subheading}>3.7 Leads your team adds (call-in leads)</h3>
              <p>
                Team members can add a lead by hand, for example when someone calls the company. They may enter the
                person&apos;s name, phone number, email address, the platform and ad the person came from, the call
                date and notes.
              </p>

              <h3 className={styles.subheading}>3.8 Work your team does in the CRM</h3>
              <p>
                We store the statuses, notes, follow-up tasks, reminders and lead assignments your team records, and a
                timeline of changes to each lead, so your team can see the history of every lead.
              </p>

              <h3 className={styles.subheading}>3.9 Browser notifications</h3>
              <p>
                If a team member turns on reminder notifications, their browser gives us a push subscription (a
                web address and encryption keys for that browser). We use it only to send that person their task
                reminders, and we delete it when it stops working. Notifications can be turned off at any time in the
                browser settings.
              </p>

              <h3 className={styles.subheading}>3.10 Billing information</h3>
              <p>
                When a company subscribes, our payment partner Razorpay collects the payment details. We do not receive
                or store card or bank details. We keep the plan, number of seats, billing period and payment status.
              </p>

              <h3 className={styles.subheading}>3.11 Technical information</h3>
              <p>
                When you use the Service, we and our hosting providers automatically process technical information
                such as IP address, browser and device type, server logs and the actions taken in the app. We use it to
                run, secure and fix the Service.
              </p>
            </section>

            <section id="how-we-use" className={styles.section}>
              <span className={styles.sectionNum}>04</span>
              <h2 className={styles.sectionTitle}>How we use information</h2>
              <p>We use the information described above only to:</p>
              <ul>
                <li>provide AgentzPro to each company, including signing people in and connecting their Facebook Pages and Google Ads accounts;</li>
                <li>receive, show and organise each company&apos;s leads, and let its team update, assign and follow up on them;</li>
                <li>show which campaign, ad group or ad each lead came from;</li>
                <li>
                  give each lead from Meta or Google Ads an AI label (Hot, Warm or Cold) to help the company decide who
                  to contact first. Before
                  a lead is labelled, we remove the name, email address and phone number from the form&apos;s contact
                  fields, as described in Section 5;
                </li>
                <li>send task reminders, account emails and team invitations;</li>
                <li>process subscription payments;</li>
                <li>keep the Service secure, find and fix problems, and improve reliability; and</li>
                <li>comply with the law and enforce our Terms of Service.</li>
              </ul>
              <p>
                <strong>We use a company&apos;s lead data only to provide that company&apos;s own CRM.</strong> We never
                market to leads ourselves, and we never sell lead data or company data to anyone.
              </p>
            </section>

            <section id="data-sharing" className={styles.section}>
              <span className={styles.sectionNum}>05</span>
              <h2 className={styles.sectionTitle}>How we share information</h2>
              <p>We do not sell personal data. We share information only in these cases:</p>
              <ul>
                <li>
                  <strong>Meta Platforms, Inc.</strong>, to connect a company&apos;s Facebook account, receive leads from
                  its connected Pages and comply with Meta&apos;s Platform Terms;
                </li>
                <li>
                  <strong>Google LLC</strong>, to connect a company&apos;s Google account, read its linked Google Ads
                  account data, and comply with Google&apos;s terms and policies;
                </li>
                <li>
                  <strong>Service providers</strong> that process data only on our instructions to run the Service:
                  <ul>
                    <li><strong>Supabase</strong>, our database provider, for secure data storage;</li>
                    <li><strong>Vercel</strong>, our hosting provider, for running the application;</li>
                    <li><strong>Upstash</strong>, for queuing incoming leads so none are lost, and for rate limiting;</li>
                    <li><strong>Resend</strong>, for sending account emails such as team invitations;</li>
                    <li><strong>Cloudflare Turnstile</strong>, for checking that a sign-in comes from a real person;</li>
                    <li><strong>Razorpay</strong>, for processing subscription payments (see Section 13);</li>
                    <li>
                      <strong>Web push services</strong> run by browser makers (such as Google, Mozilla and Apple), which
                      deliver task reminders to the browsers where notifications are turned on. Each reminder is
                      encrypted for that browser; and
                    </li>
                    <li>
                      <strong>Portkey</strong>, an AI gateway that passes a lead to an AI model provider (Google Gemini
                      models) to produce the AI label described in Section 4. Before anything is sent, we replace the
                      name, email address and phone number from the form&apos;s contact fields (full name, first and
                      last name, email and phone number) with placeholders such as [NAME], [EMAIL] and [PHONE],
                      including anywhere those same details are repeated in other answers. Only the remaining form
                      answers, the ad name and the lead&apos;s current status are sent. For a Google Ads lead, the ad
                      name is the campaign and ad group (or asset group) name. The model provider uses this data only
                      to return the label and does not use it to train its models. The label is shown only to the
                      company that owns the lead.
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>For legal reasons</strong>, when required to comply with the law or to protect the rights,
                  property or safety of AI Digital Tamizha, our customers or others.
                </li>
                <li>
                  <strong>Business transfers</strong>, as part of a merger, acquisition or sale of assets. For Google
                  user data, this happens only after we get your explicit prior consent.
                </li>
              </ul>
              <p>
                We never share one company&apos;s data with another company, and we never share lead data with anyone
                for advertising or marketing.
              </p>
            </section>

            <section id="google-user-data" className={styles.section}>
              <span className={styles.sectionNum}>06</span>
              <h2 className={styles.sectionTitle}>Google user data and Limited Use</h2>
              <div className={styles.callout}>
                <p>
                  <strong>
                    AgentzPro&apos;s use and transfer to any other app of information received from Google APIs will
                    adhere to the{" "}
                    <ExternalLink href={GOOGLE_USER_DATA_POLICY_URL}>Google API Services User Data Policy</ExternalLink>,
                    including the Limited Use requirements.
                  </strong>
                </p>
              </div>

              <h3 className={styles.subheading}>6.1 What Google data we access</h3>
              <p>
                We ask for Google access only when a company owner chooses to connect Google Ads, and we ask only for
                what the Google Ads features need:
              </p>
              <div className={styles.tableWrap}>
                <table className={`${styles.infoTable} ${styles.stackTable}`}>
                  <thead>
                    <tr><th scope="col">Permission</th><th scope="col">Why we ask for it</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><code>openid</code>, <code>email</code>, <code>profile</code></td>
                      <td>To identify the Google account that was connected and show its email address in the app.</td>
                    </tr>
                    <tr>
                      <td><code>https://www.googleapis.com/<wbr />auth/adwords</code></td>
                      <td>
                        Google offers one permission for the Google Ads API. We use it only to read: the list of Google
                        Ads accounts and their names, and the campaign, ad group and asset group names for your leads,
                        as described in Section 3.5.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h3 className={styles.subheading}>6.2 How we use Google data</h3>
              <p>
                We use Google user data only to provide and improve features that you can see in AgentzPro: showing
                which Google account is connected, letting the owner choose Google Ads accounts, showing the campaign
                and ad group each Google Ads lead came from, and the AI lead label described in Section 4.
              </p>

              <h3 className={styles.subheading}>6.3 How we store and protect Google data</h3>
              <p>
                The Google refresh token is encrypted with AES-256-GCM before it is saved. Short-lived access tokens are
                never saved. All data travels over encrypted HTTPS connections and is stored with our database
                provider, which encrypts data at rest. Google data is tied to the company that connected it and is
                protected by the database access rules described in Section 7.
              </p>

              <h3 className={styles.subheading}>6.4 Who we share Google data with</h3>
              <p>
                We transfer Google user data only to the service providers in Section 5 that we need to run the features
                above: Supabase (storage), Vercel (hosting) and, for the AI label, Portkey and Google Gemini (campaign
                and ad group names only). We transfer it otherwise only for security purposes (for example,
                investigating abuse), to comply with applicable law, or as part of a merger, acquisition or sale of
                assets after getting your explicit prior consent.
              </p>

              <h3 className={styles.subheading}>6.5 What we never do with Google data</h3>
              <ul>
                <li>We never sell Google user data.</li>
                <li>We never transfer Google user data to advertising platforms, data brokers or other information resellers.</li>
                <li>We never use Google user data to serve ads, including retargeting, personalised or interest-based ads.</li>
                <li>We never use Google user data to determine credit-worthiness or for lending.</li>
                <li>
                  We never use Google user data to develop, improve or train generalised or non-personalised artificial
                  intelligence or machine learning models.
                </li>
              </ul>

              <h3 className={styles.subheading}>6.6 Who can see Google data</h3>
              <p>
                Google Ads leads and account data are shown only to the team of the company that connected the Google
                Ads account. Our own staff do not read Google user data unless (a) you give us permission to view
                specific data, for example to help with a support request; (b) it is needed for security, such as
                investigating a bug or abuse; (c) it is needed to comply with applicable law; or (d) the data is
                aggregated and used for internal operations in line with applicable law.
              </p>

              <h3 className={styles.subheading}>6.7 Disconnecting Google and deleting Google data</h3>
              <p>AgentzPro has two separate controls on the Connection page, both for the company owner:</p>
              <ul>
                <li>
                  <strong>Disconnect Google sign-in.</strong> We revoke our access with Google and immediately delete
                  the refresh token, the list of linked Google Ads accounts and the saved campaign and ad group names.
                  We then can no longer read anything from Google Ads. We keep a record of which Google email address
                  was connected and when, as connection history, until the company asks us to delete it or closes its
                  account.
                </li>
                <li>
                  <strong>Stop Google Ads leads.</strong> Turns off the company&apos;s lead form webhook, so new Google
                  Ads leads are refused and not saved. Turning it back on creates a new secret key.
                </li>
              </ul>
              <p>
                You can also remove AgentzPro&apos;s access at any time from your Google Account at{" "}
                <ExternalLink href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</ExternalLink>.
                Leads already received, including the campaign and ad group name shown on each lead, stay in the
                company&apos;s CRM until the company deletes them or asks us to delete them, as described in Section 10.
              </p>
            </section>

            <section id="tenant-isolation" className={styles.section}>
              <span className={styles.sectionNum}>07</span>
              <h2 className={styles.sectionTitle}>Each company&apos;s data is separate</h2>
              <p>
                Every record in AgentzPro belongs to one company, and database-level access rules (row-level security
                tied to a unique company ID) are checked on every request. This is designed so that no company can
                view, search, export or otherwise reach another company&apos;s Facebook connections, Google Ads
                connections, leads or account data.
              </p>
            </section>

            <section id="retention" className={styles.section}>
              <span className={styles.sectionNum}>08</span>
              <h2 className={styles.sectionTitle}>Data retention</h2>
              <p>
                We keep company account data and lead data for as long as the company&apos;s AgentzPro account exists,
                so we can keep providing the Service. If a subscription ends, the data is kept so the company can pick
                up where it left off. When a company closes its account or asks us to delete data, as described in
                Section 10, we delete it, except for limited information we must keep to comply with the law, resolve
                disputes or enforce our agreements.
              </p>
              <p>
                Google refresh tokens are kept only while Google Ads is connected and are deleted on disconnect, as
                described in Section 6.7. Browser push subscriptions are deleted when they stop working or when you ask
                us to delete your data.
              </p>
            </section>

            <section id="security" className={styles.section}>
              <span className={styles.sectionNum}>09</span>
              <h2 className={styles.sectionTitle}>Data security</h2>
              <p>We protect the information in our care with technical and organisational measures, including:</p>
              <ul>
                <li>encryption of Facebook access tokens, Google refresh tokens and webhook keys with AES-256-GCM before they are saved;</li>
                <li>encrypted HTTPS connections for all data in transit, and encryption at rest by our database provider;</li>
                <li>signature checks on every lead Meta sends us, and a secret key check on every Google Ads lead webhook;</li>
                <li>company-separated database access rules, as described in Section 7; and</li>
                <li>automatic sign-out of inactive sessions and bot checks at sign-in.</li>
              </ul>
              <p>
                No system can be guaranteed 100% secure. If we learn of unauthorised access to your information, we will
                tell affected users promptly, as required by applicable law.
              </p>
            </section>

            <section id="your-rights" className={styles.section}>
              <span className={styles.sectionNum}>10</span>
              <h2 className={styles.sectionTitle}>Your rights and deleting your data</h2>
              <p>
                Companies, their team members and leads can ask to access, correct or delete their personal data. Here
                is how to manage and delete data in AgentzPro:
              </p>
              <ul>
                <li><strong>Delete leads:</strong> on the Leads page, tick the leads you want to remove and press Delete.</li>
                <li>
                  <strong>Disconnect Facebook:</strong> the owner disconnects a Page on the Connection page. You can also
                  remove AgentzPro from your Facebook account&apos;s Business Integrations settings.
                </li>
                <li>
                  <strong>Disconnect Google Ads:</strong> the owner disconnects Google on the Connection page, or removes
                  access at myaccount.google.com/permissions (see Section 6.7).
                </li>
                <li><strong>Turn off reminders:</strong> turn off notifications for AgentzPro in your browser settings.</li>
                <li>
                  <strong>Close an account or delete everything:</strong> email us at aidigitaltamizha@gmail.com from
                  the account&apos;s email address. A lead who wants their own details removed can contact us the same
                  way.
                </li>
              </ul>
              <p>
                We reply to every request within 3 business days. If you ask us to disconnect your Google Ads account
                from AgentzPro, we do so within 3 business days. Once we have confirmed a deletion request, we delete
                the data from our systems, except where the law requires us to keep it. Deleted data cannot be
                recovered.
              </p>
            </section>

            <section id="cookies" className={styles.section}>
              <span className={styles.sectionNum}>11</span>
              <h2 className={styles.sectionTitle}>Cookies and browser storage</h2>
              <p>
                AgentzPro does not use advertising or analytics cookies. We use only essential cookies that keep you
                securely signed in, sign out inactive sessions, and protect the Google sign-in step. The app also saves
                small preferences in your browser, such as light or dark theme. None of these track you across other
                websites.
              </p>
            </section>

            <section id="children" className={styles.section}>
              <span className={styles.sectionNum}>12</span>
              <h2 className={styles.sectionTitle}>Children&apos;s privacy</h2>
              <p>
                AgentzPro is a business product for business owners and their staff. It is not directed at children, and
                we do not knowingly collect personal data from children. If you believe a child has given us personal
                data, please contact us so we can delete it.
              </p>
            </section>

            <section id="payments" className={styles.section}>
              <span className={styles.sectionNum}>13</span>
              <h2 className={styles.sectionTitle}>Payments, cancellation and refunds</h2>
              <p>
                Paid plans are billed per seat, monthly or yearly, and payments are processed securely by our payment
                partner, Razorpay.
              </p>
              <ul>
                <li>
                  <strong>Cancel anytime.</strong> You can cancel your subscription at any time. Cancelling stops future
                  renewals, and you keep access until the end of the period you have already paid for.
                </li>
                <li><strong>No refunds.</strong> Payments already made are not refunded, for monthly or yearly plans.</li>
              </ul>
            </section>

            <section id="governing-law" className={styles.section}>
              <span className={styles.sectionNum}>14</span>
              <h2 className={styles.sectionTitle}>Governing law</h2>
              <p>
                AI Digital Tamizha is based in Chennai, Tamil Nadu, India, and processes personal data in line with
                applicable Indian law, including the Digital Personal Data Protection Act, 2023. This policy, and any
                dispute arising from it, is governed by the laws of India.
              </p>
            </section>

            <section id="changes" className={styles.section}>
              <span className={styles.sectionNum}>15</span>
              <h2 className={styles.sectionTitle}>Changes to this policy</h2>
              <p>
                We may update this policy to reflect changes in our practices or for legal or operational reasons. When
                we do, we change the &quot;Last updated&quot; date at the top of this page. If we ever want to use
                Google user data in a new way, we will tell you and ask for your consent first.
              </p>
            </section>

            <section id="contact" className={styles.section}>
              <span className={styles.sectionNum}>16</span>
              <h2 className={styles.sectionTitle}>Contact us</h2>
              <p>
                For any question or request about this policy or your personal data, including deletion requests,
                contact us:
              </p>
              <div className={styles.contactCard}>
                <div className={styles.contactGrid}>
                  <div className={styles.contactItem}>
                    <span className={styles.contactLabel}>Business</span>
                    <span className={styles.contactValue}>AI Digital Tamizha</span>
                  </div>
                  <div className={styles.contactItem}>
                    <span className={styles.contactLabel}>Email</span>
                    <a className={`${styles.contactValue} ${styles.link}`} href="mailto:aidigitaltamizha@gmail.com">
                      aidigitaltamizha@gmail.com
                    </a>
                  </div>
                  <div className={styles.contactItem}>
                    <span className={styles.contactLabel}>Phone Number</span>
                    <a className={`${styles.contactValue} ${styles.link}`} href="tel:+919047227223">
                      +91 90472 27223
                    </a>
                  </div>
                  <div className={styles.contactItem}>
                    <span className={styles.contactLabel}>Location</span>
                    <span className={styles.contactValue}>Lakshmi Nagar, Mudichur, Chennai 600028, Tamil Nadu, India</span>
                  </div>
                </div>
              </div>
              <p>
                See also our <Link className={styles.link} href="/terms">Terms of Service</Link>.
              </p>
            </section>

            <a href="#top" className={styles.backToTop}>
              <ArrowUp size={16} aria-hidden="true" /> Back to top
            </a>
          </article>
        </div>
      </main>
      <PublicSiteFooter />
    </div>
  );
}

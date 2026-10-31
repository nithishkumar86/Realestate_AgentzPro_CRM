import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight, BellRing, ChartNoAxesCombined, CheckCircle2, Inbox, LockKeyhole, Megaphone, PhoneCall, ShieldCheck,
  Sparkles, UserCheck, UsersRound,
} from "lucide-react";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { isAppError } from "@/lib/server/app-error";
import { PublicSiteFooter, PublicSiteHeader } from "@/components/public-site-chrome";
import styles from "./landing.module.css";

export const metadata: Metadata = {
  title: { absolute: "AgentzPro | Lead management CRM for Meta and Google Ads leads" },
  description:
    "AgentzPro brings your Facebook, Instagram and Google Ads leads, plus the calls your team takes, into one simple CRM with AI lead labels, follow-up reminders and team assignment.",
};

const PREVIEW_LEADS = [
  { initials: "PS", name: "Priya Sharma", source: "Facebook", status: "Site visit pending", label: "Hot" },
  { initials: "AK", name: "Arjun Kumar", source: "Google Ads", status: "Working", label: "Warm" },
  { initials: "MR", name: "Meena Raj", source: "Telecaller", status: "New Lead", label: "Cold" },
] as const;

const LABEL_CLASS = { Hot: styles.labelHot, Warm: styles.labelWarm, Cold: styles.labelCold } as const;

/**
 * Public landing page. Signed-out visitors see it with a Login button;
 * signed-in users with CRM access go straight to /leads. Other denied-access
 * destinations match the CRM layout.
 */
export default async function HomePage() {
  let isSignedOut = false;
  try {
    await requireCrmAccess();
  } catch (error) {
    if (isAppError(error) && error.code === "UNAUTHENTICATED") {
      isSignedOut = true;
    } else if (isAppError(error)) {
      if (error.code === "ONBOARDING_REQUIRED") {
        redirect("/onboarding");
      }
      if (error.code === "NO_COMPANY" || error.code === "CRM_ACCESS_DENIED" || error.code === "ACCOUNT_INTEGRITY_ERROR") {
        redirect("/billing");
      }
    }
    if (!isSignedOut) {
      throw error;
    }
  }

  if (!isSignedOut) {
    redirect("/leads");
  }

  return (
    <div className={styles.page}>
      <PublicSiteHeader />

      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="welcome-title">
          <div>
            <span className={styles.eyebrow}><span aria-hidden="true" /> Lead management CRM</span>
            <h1 id="welcome-title" className={styles.title}>
              Your next opportunity<br />
              <span>starts here.</span>
            </h1>
            <p className={styles.description}>
              AgentzPro brings your Facebook, Instagram and Google Ads leads, plus the calls your team takes, into one
              simple CRM. Every ad lead gets an AI label, every lead gets the right person to follow up, and reminders
              make sure no lead is forgotten.
            </p>
            <div className={styles.heroActions}>
              <Link href="/leads" className={styles.cta}>
                Enter CRM Leads <ArrowRight size={20} aria-hidden="true" />
              </Link>
              <Link href="#features" className={styles.ctaSecondary}>
                See what it does
              </Link>
            </div>
            <ul className={styles.trustList} aria-label="Highlights">
              <li><CheckCircle2 size={18} aria-hidden="true" /> 14-day free trial</li>
              <li><CheckCircle2 size={18} aria-hidden="true" /> No payment details to start</li>
              <li><CheckCircle2 size={18} aria-hidden="true" /> Your data is never sold</li>
            </ul>
          </div>

          <div className={styles.preview} aria-hidden="true">
            <div className={styles.previewBar}>
              <p className={styles.previewTitle}>Leads</p>
              <span className={styles.previewCount}>Today</span>
            </div>
            <ul className={styles.previewRows}>
              {PREVIEW_LEADS.map((lead) => (
                <li key={lead.name} className={styles.previewRow}>
                  <span className={styles.avatar}>{lead.initials}</span>
                  <span>
                    <span className={styles.leadName}>{lead.name}</span>
                    <span className={styles.leadMeta}>
                      <span className={styles.sourceTag}>{lead.source}</span>
                      {lead.status}
                    </span>
                  </span>
                  <span className={`${styles.label} ${LABEL_CLASS[lead.label]}`}>{lead.label}</span>
                </li>
              ))}
            </ul>
            <div className={styles.reminder}>
              <BellRing size={18} />
              Follow up with Arjun in 15 min
            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="sources-title">
          <div className={styles.sectionHead}>
            <span className={styles.eyebrow}><span aria-hidden="true" /> Lead sources</span>
            <h2 id="sources-title" className={styles.sectionTitle}>Every lead, in one place</h2>
            <p className={styles.sectionText}>
              Connect the ad accounts you already use. New leads arrive in your CRM on their own, and your team can add
              the leads that call in.
            </p>
          </div>
          <div className={styles.sources}>
            <div className={styles.sourceCard}>
              <span className={styles.icon}><Megaphone size={22} aria-hidden="true" /></span>
              <div>
                <h3>Facebook and Instagram</h3>
                <p>Leads from your Meta Lead Ads forms arrive automatically once you connect your Facebook Page.</p>
              </div>
            </div>
            <div className={styles.sourceCard}>
              <span className={styles.icon}><Inbox size={22} aria-hidden="true" /></span>
              <div>
                <h3>Google Ads</h3>
                <p>Leads from your Google Ads lead forms arrive through a private webhook made only for your company.</p>
              </div>
            </div>
            <div className={styles.sourceCard}>
              <span className={styles.icon}><PhoneCall size={22} aria-hidden="true" /></span>
              <div>
                <h3>Call-in leads</h3>
                <p>Your team adds people who call you, with the platform and ad they came from and the call date.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="features" className={styles.section} aria-labelledby="features-title">
          <div className={styles.sectionHead}>
            <span className={styles.eyebrow}><span aria-hidden="true" /> Features</span>
            <h2 id="features-title" className={styles.sectionTitle}>What AgentzPro does</h2>
            <p className={styles.sectionText}>
              Everything a sales team needs to answer leads quickly and follow up on time, without spreadsheets.
            </p>
          </div>
          <div className={styles.featureGrid}>
            <div className={styles.feature}>
              <span className={styles.icon}><Sparkles size={22} aria-hidden="true" /></span>
              <h3>AI lead labels</h3>
              <p>
                Each ad lead is labelled Hot, Warm or Cold so you know who to call first. The name, email address
                and phone number are removed before a lead is labelled.
              </p>
            </div>
            <div className={styles.feature}>
              <span className={styles.icon}><UserCheck size={22} aria-hidden="true" /></span>
              <h3>Assign leads by ad</h3>
              <p>Choose one team member for each ad, and new leads from that ad go straight to them.</p>
            </div>
            <div className={styles.feature}>
              <span className={styles.icon}><BellRing size={22} aria-hidden="true" /></span>
              <h3>Tasks and reminders</h3>
              <p>Set a follow-up with a date and time, repeat it if needed, and get a reminder when it is due.</p>
            </div>
            <div className={styles.feature}>
              <span className={styles.icon}><ChartNoAxesCombined size={22} aria-hidden="true" /></span>
              <h3>Dashboard and reports</h3>
              <p>See leads by status, label and platform at a glance, and download the dashboard as a PDF.</p>
            </div>
            <div className={styles.feature}>
              <span className={styles.icon}><UsersRound size={22} aria-hidden="true" /></span>
              <h3>Your whole team</h3>
              <p>Invite team members by email, give them a role, and block or enable access whenever you need.</p>
            </div>
            <div className={styles.feature}>
              <span className={styles.icon}><LockKeyhole size={22} aria-hidden="true" /></span>
              <h3>Private to your company</h3>
              <p>Every company&apos;s leads are kept separate. No other company can ever see your data.</p>
            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="steps-title">
          <div className={styles.sectionHead}>
            <span className={styles.eyebrow}><span aria-hidden="true" /> How it works</span>
            <h2 id="steps-title" className={styles.sectionTitle}>Up and running in minutes</h2>
          </div>
          <ol className={styles.steps}>
            <li className={styles.step}>
              <h3>Create your company</h3>
              <p>Log in with your email, name your company, and your 14-day free trial starts right away.</p>
            </li>
            <li className={styles.step}>
              <h3>Connect your lead sources</h3>
              <p>Connect your Facebook Page and your Google Ads account from the Connection page.</p>
            </li>
            <li className={styles.step}>
              <h3>Follow up on every lead</h3>
              <p>New ad leads arrive with an AI label. Your team updates the status, adds notes and sets reminders.</p>
            </li>
          </ol>
        </section>

        <section id="your-data" className={styles.section} aria-labelledby="data-title">
          <div className={styles.sectionHead}>
            <span className={styles.eyebrow}><span aria-hidden="true" /> Your data</span>
            <h2 id="data-title" className={styles.sectionTitle}>Your accounts stay in your control</h2>
            <p className={styles.sectionText}>
              We only use your data to run your CRM. We never sell it, and you can disconnect at any time.
            </p>
          </div>
          <div className={styles.trustGrid}>
            <div className={styles.trustCard}>
              <div className={styles.trustHead}>
                <span className={styles.icon}><ShieldCheck size={22} aria-hidden="true" /></span>
                <h3>Google Ads</h3>
              </div>
              <ul>
                <li>
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <span>
                    We use your Google Ads permission only to read your account, campaign and ad group names, so each
                    lead shows where it came from.
                  </span>
                </li>
                <li>
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <span>We never create, change or pause campaigns, and never touch your budgets, bids or billing.</span>
                </li>
                <li>
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <span>
                    Disconnect Google from the Connection page whenever you like. We then revoke our access and delete
                    your sign-in token.
                  </span>
                </li>
              </ul>
            </div>
            <div className={styles.trustCard}>
              <div className={styles.trustHead}>
                <span className={styles.icon}><Megaphone size={22} aria-hidden="true" /></span>
                <h3>Facebook and Instagram</h3>
              </div>
              <ul>
                <li>
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <span>We only receive the leads from the Facebook Pages you choose to connect.</span>
                </li>
                <li>
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <span>Page access is stored encrypted and is used only to deliver your own leads to you.</span>
                </li>
                <li>
                  <CheckCircle2 size={18} aria-hidden="true" />
                  <span>Disconnect a Page from the Connection page at any time to stop new leads from it.</span>
                </li>
              </ul>
            </div>
          </div>
          <p className={styles.policyNote}>
            AgentzPro&apos;s use and transfer to any other app of information received from Google APIs will adhere to
            the{" "}
            <a
              className={styles.inlineLink}
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.{" "}
            <Link href="/privacy-policy#google-user-data" className={styles.inlineLink}>
              How we use Google data
            </Link>
          </p>
        </section>

        <section className={styles.ctaBand} aria-labelledby="cta-title">
          <div>
            <h2 id="cta-title">Start your 14-day free trial</h2>
            <p>Every feature included. No payment details needed to start.</p>
          </div>
          <Link href="/login" className={styles.ctaLight}>
            Get started <ArrowRight size={20} aria-hidden="true" />
          </Link>
        </section>
      </main>

      <PublicSiteFooter />
    </div>
  );
}

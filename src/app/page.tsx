import { redirect } from "next/navigation";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { isAppError } from "@/lib/server/app-error";
import Link from "next/link";
import { ArrowRight, ChartNoAxesCombined, Layers3, UsersRound } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import styles from "./landing.module.css";

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
      if (error.code === "WORKSPACE_SELECTION_REQUIRED") {
        redirect("/workspaces");
      }
      if (error.code === "CRM_ACCESS_DENIED" || error.code === "ACCOUNT_INTEGRITY_ERROR") {
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
      <header className={styles.header}>
        <BrandLogo />
        <nav className={styles.headerActions} aria-label="Account">
          <Link href="/pricing" className={styles.pricingButton}>
            Pricing
          </Link>
          <Link href="/login" className={styles.loginButton}>
            Login
          </Link>
        </nav>
      </header>

      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="welcome-title">
          <span className={styles.eyebrow}><span aria-hidden="true" /> WELCOME TO AGENTZPRO</span>
          <h1 id="welcome-title" className={styles.title}>
            Your next opportunity<br />
            <span>starts here.</span>
          </h1>
          <p className={styles.description}>
            A little more clarity. A lot more possibility.<br />
            Your workspace for managing leads and customer relationships.
          </p>
          <Link href="/leads" className={styles.cta}>
            Enter CRM Leads <ArrowRight size={20} aria-hidden="true" />
          </Link>
          <p className={styles.caption}>Your leads. Your relationships. Your next chapter.</p>
        </section>

        <section className={styles.features} aria-label="Your workspace at a glance">
          <div className={styles.feature}>
            <span className={styles.icon}><Layers3 size={22} aria-hidden="true" /></span>
            <h2>Every lead, in one place.</h2>
            <p>Bring your leads into focus with an organized workspace.</p>
          </div>
          <div className={styles.feature}>
            <span className={styles.icon}><UsersRound size={22} aria-hidden="true" /></span>
            <h2>Make every connection count.</h2>
            <p>Keep customer details close and your next conversation in mind.</p>
          </div>
          <div className={styles.feature}>
            <span className={styles.icon}><ChartNoAxesCombined size={22} aria-hidden="true" /></span>
            <h2>See the bigger picture.</h2>
            <p>Open your dashboard for a clear view of your lead activity.</p>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerLeft}>
          <span>&copy; {new Date().getFullYear()} AI Digital Tamizha. All rights reserved.</span>
        </div>
        <div className={styles.footerRight}>
          <Link href="/contact" className={styles.footerLink}>
            Contact Us
          </Link>
          <Link href="/privacy-policy" className={styles.footerLink}>
            Privacy Policy
          </Link>
        </div>
      </footer>
    </div>
  );
}

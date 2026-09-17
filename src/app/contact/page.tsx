import Link from "next/link";
import type { Metadata } from "next";
import styles from "../privacy-policy/privacy-policy.module.css";

export const metadata: Metadata = {
  title: "Contact Us | AgentzPro CRM",
  description:
    "Contact AI Digital Tamizha, the team behind AgentzPro CRM, by email, phone, or at our Chennai location.",
};

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
        </nav>
      </div>
    </footer>
  );
}

export default function ContactUsPage() {
  return (
    <>
      <SiteHeader />
      <main className={`${styles.container} ${styles.policyWrap}`}>
        <div className={styles.policyHeader}>
          <span className={styles.policyBadge}>Contact Us</span>
          <h1 className={styles.policyTitle}>Get in Touch</h1>
          <p className={styles.policyIntro}>
            Have a question about AgentzPro CRM? Reach us using the details
            below.
          </p>
        </div>

        <section className={`${styles.section} ${styles.sectionNoBorder}`}>
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
      </main>
      <SiteFooter />
    </>
  );
}

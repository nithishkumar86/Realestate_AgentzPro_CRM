import type { Metadata } from "next";
import { PublicSiteFooter, PublicSiteHeader } from "@/components/public-site-chrome";
import landing from "../landing.module.css";
import styles from "../privacy-policy/privacy-policy.module.css";

export const metadata: Metadata = {
  title: { absolute: "Contact Us | AgentzPro" },
  description:
    "Contact AI Digital Tamizha, the team behind AgentzPro, by email, phone, or at our Chennai location.",
};

export default function ContactUsPage() {
  return (
    <div className={landing.page}>
      <PublicSiteHeader />
      <main className={`${styles.container} ${styles.policyWrap}`}>
        <div className={styles.policyHeader}>
          <span className={styles.policyBadge}>Contact Us</span>
          <h1 className={styles.policyTitle}>Get in touch</h1>
          <p className={styles.policyIntro}>
            Have a question about AgentzPro, your account, or your data? Reach us using the details below.
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
        </section>
      </main>
      <PublicSiteFooter />
    </div>
  );
}

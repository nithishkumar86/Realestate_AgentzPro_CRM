import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";
import landing from "@/app/landing.module.css";

/** Header of the public pages (home, contact, privacy policy, terms): logo home link, Pricing and Login. */
export function PublicSiteHeader() {
  return (
    <header className={landing.header}>
      <Link href="/" aria-label="AgentzPro home">
        <BrandLogo />
      </Link>
      <nav className={landing.headerActions} aria-label="Account">
        <Link href="/pricing" className={landing.pricingButton}>
          Pricing
        </Link>
        <Link href="/login" className={landing.loginButton}>
          Login
        </Link>
      </nav>
    </header>
  );
}

/** Footer of the public pages. The Privacy Policy link must stay on the home page for Google verification. */
export function PublicSiteFooter() {
  return (
    <footer className={landing.footer}>
      <div className={landing.footerLeft}>
        <span>&copy; {new Date().getFullYear()} AI Digital Tamizha. All rights reserved.</span>
      </div>
      <nav className={landing.footerRight} aria-label="Legal">
        <Link href="/contact" className={landing.footerLink}>
          Contact Us
        </Link>
        <Link href="/privacy-policy" className={landing.footerLink}>
          Privacy Policy
        </Link>
        <Link href="/terms" className={landing.footerLink}>
          Terms of Service
        </Link>
      </nav>
    </footer>
  );
}

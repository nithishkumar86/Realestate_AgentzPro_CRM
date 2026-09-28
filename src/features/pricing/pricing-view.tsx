"use client";

import { ArrowRight, Check, CreditCard, ShieldCheck, Sparkles, UsersRound } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { PLAN_FEATURES } from "@/features/billing/plan-features";
import type { BillingPlanOption } from "@/lib/server/billing-service";
import landing from "@/app/landing.module.css";
import styles from "@/app/pricing/pricing.module.css";

type Period = "monthly" | "yearly";

const TRIAL_FEATURES = [
  "Every Pro feature, unlocked",
  "Invite your whole team",
  "Connect your Meta Lead Ads",
  "No credit card required",
];

const FAQS = [
  {
    question: "How does the free trial work?",
    answer:
      "Log in and create your company — your 14-day trial starts right away with every Pro feature. No payment details are needed to start.",
  },
  {
    question: "What happens when the trial ends?",
    answer:
      "Your data stays safe, but CRM access pauses until the company owner subscribes to Pro from Settings → Billing.",
  },
  {
    question: "How are seats counted?",
    answer: "One seat per person in your company, including you. Add seats any time as your team grows.",
  },
  {
    question: "Can I cancel anytime?",
    answer: "Yes. Cancel from Settings → Billing and your plan won't renew — you keep access until the end of the period you paid for.",
  },
];

function formatRupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(paise / 100);
}

export function PricingView({ plans }: Readonly<{ plans: BillingPlanOption[] }>) {
  const monthly = plans.find((plan) => plan.billingPeriod === "monthly") ?? null;
  const yearly = plans.find((plan) => plan.billingPeriod === "yearly") ?? null;
  const [period, setPeriod] = useState<Period>(monthly ? "monthly" : "yearly");
  const selected = period === "yearly" ? yearly : monthly;

  // Yearly vs twelve monthly payments, rounded down so we never overstate the saving.
  const yearlySavingPercent = useMemo(() => {
    if (!monthly || !yearly) {
      return 0;
    }
    const fullYear = monthly.pricePerSeatPaise * 12;
    return Math.max(0, Math.floor(((fullYear - yearly.pricePerSeatPaise) / fullYear) * 100));
  }, [monthly, yearly]);

  return (
    <div className={landing.page}>
      <header className={landing.header}>
        <Link href="/" aria-label="AgentzPro home" className={styles.homeLink}>
          <BrandLogo />
        </Link>
        <nav className={landing.headerActions} aria-label="Account">
          <Link href="/login" className={landing.loginButton}>
            Login
          </Link>
        </nav>
      </header>

      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="pricing-title">
          <span className={landing.eyebrow}>
            <span aria-hidden="true" /> PRICING
          </span>
          <h1 id="pricing-title" className={styles.title}>
            Simple pricing,
            <br />
            <span>built to grow with you.</span>
          </h1>
          <p className={styles.description}>Try everything free for 14 days. Upgrade to Pro when your team is ready — pay only per seat.</p>

          {monthly && yearly ? (
            <div className={styles.toggle} role="radiogroup" aria-label="Billing period">
              {(["monthly", "yearly"] as const).map((option) => (
                <label key={option} className={option === period ? `${styles.toggleOption} ${styles.toggleOptionOn}` : styles.toggleOption}>
                  <input type="radio" name="pricing-period" value={option} checked={option === period} onChange={() => setPeriod(option)} />
                  {option === "monthly" ? "Monthly" : "Yearly"}
                  {option === "yearly" && yearlySavingPercent > 0 ? <span className={styles.saveBadge}>Save {yearlySavingPercent}%</span> : null}
                </label>
              ))}
            </div>
          ) : null}
        </section>

        <section className={styles.plans} aria-label="Plans">
          <article className={styles.card} aria-labelledby="plan-trial">
            <div className={styles.cardHead}>
              <span className={styles.planIcon}>
                <Sparkles size={20} aria-hidden="true" />
              </span>
              <h2 id="plan-trial" className={styles.planName}>
                Free Trial
              </h2>
            </div>
            <p className={styles.planTagline}>Explore the full CRM with your team, risk free.</p>
            <p className={styles.price}>
              <span className={styles.amount}>₹0</span>
              <span className={styles.unit}>for 14 days</span>
            </p>
            <p className={styles.priceNote}>No credit card required</p>
            <Link href="/login" className={`${styles.cta} ${styles.ctaSecondary}`}>
              Start 14-day free trial <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <FeatureList heading="What you get:" features={TRIAL_FEATURES} />
          </article>

          <article className={`${styles.card} ${styles.cardPro}`} aria-labelledby="plan-pro">
            <span className={styles.popular}>Most popular</span>
            <div className={styles.cardHead}>
              <span className={`${styles.planIcon} ${styles.planIconPro}`}>
                <UsersRound size={20} aria-hidden="true" />
              </span>
              <h2 id="plan-pro" className={styles.planName}>
                Pro
              </h2>
            </div>
            <p className={styles.planTagline}>Capture, qualify and follow up every Meta lead.</p>
            {selected ? (
              // key= replays the fade-in when the period (and so the price) changes.
              <div key={selected.planCode} className={styles.priceBlock}>
                <p className={styles.price}>
                  <span className={styles.amount}>
                    {formatRupees(period === "yearly" ? selected.pricePerSeatPaise / 12 : selected.pricePerSeatPaise)}
                  </span>
                  <span className={styles.unit}>/ seat / month</span>
                </p>
                <p className={styles.priceNote}>
                  {period === "yearly" ? `${formatRupees(selected.pricePerSeatPaise)} per seat, billed yearly` : "Billed monthly · cancel anytime"}
                </p>
              </div>
            ) : (
              <div className={styles.priceBlock}>
                <p className={styles.price}>
                  <span className={styles.amountSmall}>Per-seat pricing</span>
                </p>
                <p className={styles.priceNote}>See current prices after you log in</p>
              </div>
            )}
            <Link href="/login" className={styles.cta}>
              Get Pro <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <FeatureList heading="Everything in Pro:" features={PLAN_FEATURES} />
          </article>
        </section>

        <ul className={styles.trust} aria-label="Why teams trust us">
          <li>
            <ShieldCheck size={18} aria-hidden="true" /> Every company&apos;s data kept separate
          </li>
          <li>
            <CreditCard size={18} aria-hidden="true" /> Secure payments with Razorpay
          </li>
          <li>
            <Check size={18} aria-hidden="true" /> Cancel anytime
          </li>
        </ul>

        <section className={styles.faq} aria-labelledby="faq-title">
          <h2 id="faq-title" className={styles.faqTitle}>
            Frequently asked questions
          </h2>
          <div className={styles.faqList}>
            {FAQS.map((faq) => (
              <details key={faq.question} className={styles.faqItem}>
                <summary>{faq.question}</summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className={landing.footer}>
        <div className={landing.footerLeft}>
          <span>&copy; {new Date().getFullYear()} AI Digital Tamizha. All rights reserved.</span>
        </div>
        <div className={landing.footerRight}>
          <Link href="/contact" className={landing.footerLink}>
            Contact Us
          </Link>
          <Link href="/privacy-policy" className={landing.footerLink}>
            Privacy Policy
          </Link>
        </div>
      </footer>
    </div>
  );
}

function FeatureList({ heading, features }: Readonly<{ heading: string; features: readonly string[] }>) {
  return (
    <div className={styles.features}>
      <p>{heading}</p>
      <ul>
        {features.map((feature) => (
          <li key={feature}>
            <span className={styles.check}>
              <Check size={14} aria-hidden="true" />
            </span>
            {feature}
          </li>
        ))}
      </ul>
    </div>
  );
}

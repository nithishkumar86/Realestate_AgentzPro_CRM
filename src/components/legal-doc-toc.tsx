import styles from "@/app/privacy-policy/privacy-policy.module.css";

type TocEntry = readonly [id: string, label: string];

function TocLinks({ entries }: { entries: readonly TocEntry[] }) {
  return (
    <ul className={styles.tocList}>
      {entries.map(([id, label]) => (
        <li key={id}>
          <a href={`#${id}`}>{label}</a>
        </li>
      ))}
    </ul>
  );
}

/** Sticky contents list beside the document on wide screens. */
export function LegalDocToc({ entries }: { entries: readonly TocEntry[] }) {
  return (
    <nav className={styles.toc} aria-label="Table of contents">
      <p className={styles.tocTitle}>On this page</p>
      <TocLinks entries={entries} />
    </nav>
  );
}

/** The same contents list as a closed disclosure above the document on phones and tablets. */
export function LegalDocTocMobile({ entries }: { entries: readonly TocEntry[] }) {
  return (
    <details className={styles.tocMobile}>
      <summary>On this page</summary>
      <nav aria-label="Table of contents">
        <TocLinks entries={entries} />
      </nav>
    </details>
  );
}

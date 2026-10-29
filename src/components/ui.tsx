import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { ReactNode } from "react";

type Tone = "info" | "success" | "warning" | "danger";

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  if (!actions) {
    return (
      <div className="page-header">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
    );
  }
  // `actions` (the dashboard's platform switch) sits at the top right and wraps under the title on a narrow screen.
  return (
    <div className="page-header page-header--with-actions">
      <div className="page-header__text">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      <div className="page-header__actions">{actions}</div>
    </div>
  );
}

export function StatusBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`status-badge status-badge--${tone}`}>{children}</span>;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="empty-state">
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div>{action}</div> : null}
    </section>
  );
}

export function Notice({
  tone,
  title,
  children,
  action,
}: {
  tone: Tone;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "danger" ? XCircle : AlertTriangle;

  return (
    <div className={`notice notice--${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon aria-hidden="true" size={18} />
      <div>
        <strong>{title}</strong>
        {children ? <p>{children}</p> : null}
      </div>
      {action ? <div className="notice__action">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <Loader2 className="spin" aria-hidden="true" size={22} />
      <span>{label}</span>
    </div>
  );
}

export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div className="skeleton-stack" aria-label="Loading content">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton-row" key={index} />
      ))}
    </div>
  );
}

export function displayValue(value: string | null | undefined): string {
  return value && value.trim() ? value : "—";
}

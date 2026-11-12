import type { LucideIcon } from "lucide-react";

/** Heading of one lead-source card on the Integrations page: a colored icon badge, the title and a one-line description. */
export function IntegrationCardTitle({ id, icon: Icon, title, description }: { id: string; icon: LucideIcon; title: string; description: string }) {
  return <div className="integration-card__title">
    <span className="integration-card__icon" aria-hidden="true"><Icon size={20} /></span>
    <div><h2 id={id}>{title}</h2><p>{description}</p></div>
  </div>;
}

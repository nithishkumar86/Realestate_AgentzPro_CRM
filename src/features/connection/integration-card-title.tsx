import type { ComponentType } from "react";

/** Heading of one lead-source card on the Integrations page: an icon badge (brand logo or icon), the title and a one-line description. */
export function IntegrationCardTitle({ id, icon: Icon, title, description }: { id: string; icon: ComponentType<{ size?: number }>; title: string; description: string }) {
  return <div className="integration-card__title">
    <span className="integration-card__icon" aria-hidden="true"><Icon size={20} /></span>
    <div><h2 id={id}>{title}</h2><p>{description}</p></div>
  </div>;
}

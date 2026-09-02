import { BrandLogo } from "@/components/brand-logo";
import { LoadingState } from "@/components/ui";

export default function Loading() {
  return (
    <div className="loading-screen">
      <div className="loading-screen__content">
        <BrandLogo compact />
        <LoadingState label="Preparing your CRM..." />
      </div>
    </div>
  );
}

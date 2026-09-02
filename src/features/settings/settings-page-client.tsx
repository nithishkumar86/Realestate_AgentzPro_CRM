"use client";

import { Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { LoadingState, Notice, PageHeader } from "@/components/ui";
import { type SettingsData } from "@/lib/types";
import { getSettingsData, saveSettingsData } from "@/services/crm-data-service";

export function SettingsPageClient() {
  const [initialData, setInitialData] = useState<SettingsData | null>(null);
  const [formData, setFormData] = useState<SettingsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadSettings() {
      try {
        const data = await getSettingsData();
        if (isMounted) {
          setInitialData(data);
          setFormData(data);
        }
      } catch {
        if (isMounted) {
          setMessage({ tone: "danger", text: "Settings could not be loaded. Try again." });
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadSettings();

    return () => {
      isMounted = false;
    };
  }, []);

  const hasUnsavedChanges = useMemo(() => JSON.stringify(initialData) !== JSON.stringify(formData), [formData, initialData]);

  async function handleSave() {
    if (!formData) {
      return;
    }

    try {
      setMessage(null);
      setIsSaving(true);
      const result = await saveSettingsData(formData);
      setInitialData(result.data);
      setFormData(result.data);
      setMessage({ tone: "success", text: result.message });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Settings could not be saved." });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Settings" description="Frontend demo fields for Profile and Company information." />

      {message ? <Notice tone={message.tone} title={message.text} /> : null}
      {isLoading ? <LoadingState label="Loading settings" /> : null}

      {!isLoading && formData ? (
        <section className="panel">
          <div className="panel__body stack">
            <div id="profile">
              <div className="section-title">
                <div>
                  <h2>Profile</h2>
                  <p>The final fields and save behaviour will be connected during the login-system phase.</p>
                </div>
              </div>
              <div className="form-grid">
                <Field label="Full name" value={formData.profile.fullName} onChange={(value) => setFormData({ ...formData, profile: { ...formData.profile, fullName: value } })} />
                <Field label="Email" type="email" value={formData.profile.emailAddress} onChange={(value) => setFormData({ ...formData, profile: { ...formData.profile, emailAddress: value } })} />
                <Field label="Phone" value={formData.profile.phoneNumber} onChange={(value) => setFormData({ ...formData, profile: { ...formData.profile, phoneNumber: value } })} />
                <Field label="Role title" value={formData.profile.roleTitle} onChange={(value) => setFormData({ ...formData, profile: { ...formData.profile, roleTitle: value } })} />
              </div>
            </div>

            <div id="company">
              <div className="section-title">
                <div>
                  <h2>Company information</h2>
                  <p>Facebook connection management remains on the Connection page.</p>
                </div>
              </div>
              <div className="form-grid">
                <Field label="Company name" value={formData.company.companyName} onChange={(value) => setFormData({ ...formData, company: { ...formData.company, companyName: value } })} />
                <Field label="Business type" value={formData.company.businessType} onChange={(value) => setFormData({ ...formData, company: { ...formData.company, businessType: value } })} />
                <Field label="Primary market" value={formData.company.primaryMarket} onChange={(value) => setFormData({ ...formData, company: { ...formData.company, primaryMarket: value } })} />
                <Field label="Website" type="url" value={formData.company.website} onChange={(value) => setFormData({ ...formData, company: { ...formData.company, website: value } })} />
              </div>
            </div>

            <div id="subscription">
              <div className="section-title">
                <div>
                  <h2>Subscription</h2>
                  <p>Frontend-only subscription display. Billing behaviour is not included in this phase.</p>
                </div>
              </div>
              <p className="field-help">Subscription details will be available in a later phase.</p>
            </div>

            <div className="form-actions">
              {hasUnsavedChanges ? <span className="field-help">Unsaved changes</span> : <span className="field-help">Saved</span>}
              <button className="button" type="button" disabled={isSaving || !hasUnsavedChanges} onClick={() => void handleSave()}>
                <Save aria-hidden="true" size={18} />
                {isSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </section>
      ) : null}

    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  const id = label.toLowerCase().replace(/\s+/g, "-");

  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

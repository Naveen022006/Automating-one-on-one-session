"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconExternal } from "@/components/icons";
import { Wordmark } from "@/components/site/SiteChrome";
import { CopyField, ToastProvider, useToast } from "@/components/ui/overlays";
import { Alert, Button, Card, Stepper } from "@/components/ui/primitives";
import { ApiProvider, useApi } from "./ApiProvider";
import { BlockedDays, WeeklyHours, type BlockedRow, type RuleRow } from "./AvailabilityEditor";
import { GoogleConnect, type GoogleStatusView } from "./GoogleConnect";
import { ServicesManager, type ServiceAdmin } from "./ServicesManager";
import { ProfileForm, VerifyBanner, type ProfileData } from "./SettingsForms";

const STEPS = ["Profile", "First service", "Availability", "Google Calendar", "Preview and share"];

export interface OnboardingData {
  step: number;
  profile: ProfileData;
  services: ServiceAdmin[];
  rules: RuleRow[];
  blocked: BlockedRow[];
  google: GoogleStatusView;
  googleOutcome: string | null;
  publicUrl: string;
  email: string;
  emailVerified: boolean;
}

export function OnboardingWizard(props: OnboardingData) {
  return (
    <ToastProvider>
      <ApiProvider>
        <Wizard {...props} />
      </ApiProvider>
    </ToastProvider>
  );
}

function Wizard(d: OnboardingData) {
  const router = useRouter();
  const api = useApi();
  const toast = useToast();
  const [step, setStep] = useState(Math.min(Math.max(d.step, 0), STEPS.length - 1));
  const [busy, setBusy] = useState(false);

  function go(n: number) {
    setStep(n);
    router.replace(`/onboarding?step=${n}`);
    window.scrollTo({ top: 0 });
  }

  const canContinue = step === 1 ? d.services.some((s) => s.active) : step === 2 ? d.rules.length > 0 : true;

  async function finish() {
    setBusy(true);
    const r = await api("/api/dashboard/onboarding", { body: {} });
    setBusy(false);
    if (!r.ok) return toast(r.data.error ?? "Could not finish onboarding.", "error");
    window.location.assign("/dashboard");
  }

  return (
    <div className="focused">
      <header className="focused__header">
        <div className="container row row--between">
          <Wordmark href="/onboarding" />
          <span className="subtle">
            Step {step + 1} of {STEPS.length}
          </span>
        </div>
      </header>
      <main id="main" className="container container--narrow" style={{ paddingBottom: 64 }}>
        <div className="stack stack--lg">
          <Stepper steps={STEPS} current={step} />
          {!d.emailVerified && <VerifyBanner email={d.email} />}

          {step === 0 && (
            <Section title="Tell customers who you are" lede="This appears at the top of your booking page.">
              <ProfileForm profile={d.profile} submitLabel="Save and continue" onSaved={() => go(1)} />
            </Section>
          )}

          {step === 1 && (
            <Section title="Create your first service" lede="What can people book? You can add more later.">
              <ServicesManager services={d.services} compact />
            </Section>
          )}

          {step === 2 && (
            <Section title="When are you available?" lede="Add weekly hours. Customers only see open times inside them.">
              <div className="stack">
                <WeeklyHours rules={d.rules} timezone={d.profile.timezone} />
                <BlockedDays blocked={d.blocked} timezone={d.profile.timezone} />
              </div>
            </Section>
          )}

          {step === 3 && (
            <Section title="Connect Google Calendar" lede="Meet links are created on your own calendar, and customers get Google's invite.">
              <Card>
                <GoogleConnect status={d.google} returnTo="/onboarding?step=3" outcome={d.googleOutcome} />
              </Card>
              {d.google.state !== "connected" && (
                <p className="subtle">You can skip this for now, but paid bookings will wait for a Meet link until you connect.</p>
              )}
            </Section>
          )}

          {step === 4 && (
            <Section title="Preview and share your page" lede="This is the link to put in your bio, posts and messages.">
              <Card>
                <div className="stack">
                  <CopyField value={d.publicUrl} />
                  <a className="btn" href={d.publicUrl} target="_blank" rel="noopener noreferrer">
                    <IconExternal size={16} /> Preview booking page
                  </a>
                  {!d.emailVerified && <Alert tone="info">The page goes live for customers as soon as you confirm your email.</Alert>}
                </div>
              </Card>
            </Section>
          )}

          <div className="row row--between">
            <Button variant="ghost" onClick={() => go(step - 1)} disabled={step === 0}>
              Back
            </Button>
            {step < STEPS.length - 1 ? (
              step !== 0 && (
                <Button variant="primary" onClick={() => go(step + 1)} disabled={!canContinue}>
                  {step === 3 && d.google.state !== "connected" ? "Skip for now" : "Continue"}
                </Button>
              )
            ) : (
              <Button variant="primary" onClick={finish} loading={busy}>
                Finish and open dashboard
              </Button>
            )}
          </div>
          {!canContinue && (
            <p className="subtle" style={{ textAlign: "right" }}>
              {step === 1 ? "Add a service to continue." : "Add at least one block of weekly hours to continue."}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

function Section({ title, lede, children }: { title: string; lede: string; children: React.ReactNode }) {
  return (
    <section className="stack">
      <div className="stack stack--sm">
        <h1 className="focused__title">{title}</h1>
        <p className="muted">{lede}</p>
      </div>
      {children}
    </section>
  );
}

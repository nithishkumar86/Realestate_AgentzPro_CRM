"use client";

import { useEffect, useRef } from "react";

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";

interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
}

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

let turnstileScriptLoadPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) {
    return Promise.resolve();
  }

  if (!turnstileScriptLoadPromise) {
    turnstileScriptLoadPromise = new Promise((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
      if (existingScript) {
        existingScript.addEventListener("load", () => resolve(), { once: true });
        existingScript.addEventListener("error", () => reject(new Error("Turnstile script failed to load.")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("Turnstile script failed to load.")), { once: true });
      document.head.appendChild(script);
    });
  }

  return turnstileScriptLoadPromise;
}

export interface TurnstileWidgetProps {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire?: () => void;
}

export function TurnstileWidget({ siteKey, onVerify, onExpire }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) {
          return;
        }
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: onVerify,
          "expired-callback": onExpire,
        });
      })
      .catch(() => {
        // Turnstile is unavailable client-side. The Send button stays
        // disabled (the parent form requires a token), and the server
        // still enforces its own Turnstile check on submit.
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, onVerify, onExpire]);

  return <div ref={containerRef} className="auth-turnstile" />;
}

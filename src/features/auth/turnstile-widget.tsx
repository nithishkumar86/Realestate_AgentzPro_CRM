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
    turnstileScriptLoadPromise = new Promise<void>((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
      const script = existingScript ?? document.createElement("script");

      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("Turnstile script failed to load.")), { once: true });

      if (!existingScript) {
        script.src = TURNSTILE_SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
    }).catch((error: unknown) => {
      // Do not cache a rejected promise: a single transient network blip
      // would otherwise disable the CAPTCHA — and therefore login — for
      // the entire lifetime of the page, with a retry impossible.
      turnstileScriptLoadPromise = null;
      throw error;
    });
  }

  return turnstileScriptLoadPromise;
}

export interface TurnstileWidgetProps {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire?: () => void;
  /**
   * Increment to discard the current token and issue a fresh challenge.
   * Required after every submit: Turnstile tokens are single-use, so
   * resubmitting a spent one always fails server-side verification.
   */
  resetSignal?: number;
}

export function TurnstileWidget({ siteKey, onVerify, onExpire, resetSignal = 0 }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  // The callbacks are held in refs and read indirectly so that a parent
  // passing inline arrow functions (a new identity on every render) does
  // not re-run the effect. Putting them in the dependency array instead
  // tears down and re-renders the whole widget on every keystroke in the
  // parent's form, which visibly flickers and makes an interactive
  // challenge impossible to complete.
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);

  useEffect(() => {
    onVerifyRef.current = onVerify;
    onExpireRef.current = onExpire;
  }, [onVerify, onExpire]);

  useEffect(() => {
    let cancelled = false;

    void loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) {
          return;
        }
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token) => onVerifyRef.current(token),
          "expired-callback": () => onExpireRef.current?.(),
          "error-callback": () => onExpireRef.current?.(),
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
  }, [siteKey]);

  useEffect(() => {
    // Skip the initial render; the widget is already fresh there.
    if (resetSignal === 0) {
      return;
    }
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, [resetSignal]);

  return <div ref={containerRef} className="auth-turnstile" />;
}

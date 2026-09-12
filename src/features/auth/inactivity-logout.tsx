"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { startInactivityTracking } from "@/features/auth/inactivity";

export function InactivityLogout() {
  const router = useRouter();
  const pathname = usePathname();
  const tracker = useRef<ReturnType<typeof startInactivityTracking> | null>(null);
  const previousPath = useRef(pathname);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const instance = startInactivityTracking({
      onSignedOut: () => { router.replace("/login"); router.refresh(); },
      onError: setFailed,
    });
    tracker.current = instance;
    return () => { instance.stop(); tracker.current = null; };
  }, [router]);

  useEffect(() => {
    if (previousPath.current !== pathname) tracker.current?.activity();
    previousPath.current = pathname;
  }, [pathname]);

  return failed ? (
    <div role="alert" className="auth-error">
      Your session has been inactive for eight hours. Logout could not complete. Check your connection.
      <button type="button" className="button button--secondary" onClick={() => tracker.current?.retry()}>Retry logout</button>
    </div>
  ) : null;
}

import { useEffect, useState } from "react";
import type { SessionSnapshot } from "../types";

const STORAGE_KEY = "varix.session";

export function useTraderSession() {
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      setSessionToken(stored);
    }
    setHydrated(true);
  }, []);

  function persistSession(session: SessionSnapshot | null) {
    if (session) {
      window.localStorage.setItem(STORAGE_KEY, session.sessionToken);
      setSessionToken(session.sessionToken);
      return;
    }
    window.localStorage.removeItem(STORAGE_KEY);
    setSessionToken(null);
  }

  return {
    sessionToken,
    hydrated,
    persistSession
  };
}

import { ApiProvider, AccountProvider, AlertProvider } from "@gear-js/react-hooks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AlertTemplate } from "../components/AlertTemplate";
import { VARA_RPC_URL } from "../lib/config";
import type { TradeMode } from "../types";

const queryClient = new QueryClient();
const TRADE_MODE_PREFERENCE_KEY = "varix:trade-mode";

type VaraProvidersProps = {
  children: ReactNode;
};

function readTradeModePreference(): TradeMode {
  if (typeof window === "undefined") {
    return "vara";
  }

  return window.localStorage.getItem(TRADE_MODE_PREFERENCE_KEY) === "vara-eth" ? "vara-eth" : "vara";
}

function AlertsOnlyProvider({ children }: VaraProvidersProps) {
  return (
    <AlertProvider containerClassName="gear-alerts" template={AlertTemplate}>
      {children}
    </AlertProvider>
  );
}

export function VaraProviders({ children }: VaraProvidersProps) {
  const [tradeMode, setTradeMode] = useState<TradeMode>(() => readTradeModePreference());

  useEffect(() => {
    const handleStorage = () => {
      setTradeMode(readTradeModePreference());
    };
    const handleTradeModeChange = (event: Event) => {
      const nextTradeMode = (event as CustomEvent<TradeMode>).detail;
      setTradeMode(nextTradeMode === "vara-eth" ? "vara-eth" : "vara");
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("varix:trade-mode-change", handleTradeModeChange);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("varix:trade-mode-change", handleTradeModeChange);
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {tradeMode === "vara-eth" ? (
        <AlertsOnlyProvider>{children}</AlertsOnlyProvider>
      ) : (
        <ApiProvider initialArgs={{ endpoint: VARA_RPC_URL }}>
          <AccountProvider appName="Varix Perps">
            <AlertsOnlyProvider>{children}</AlertsOnlyProvider>
          </AccountProvider>
        </ApiProvider>
      )}
    </QueryClientProvider>
  );
}

import { ApiProvider, AccountProvider, AlertProvider } from "@gear-js/react-hooks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AlertTemplate } from "../components/AlertTemplate";
import { VARA_RPC_URL } from "../lib/config";

const queryClient = new QueryClient();

type VaraProvidersProps = {
  children: ReactNode;
};

export function VaraProviders({ children }: VaraProvidersProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider initialArgs={{ endpoint: VARA_RPC_URL }}>
        <AccountProvider appName="Varix Perps">
          <AlertProvider containerClassName="gear-alerts" template={AlertTemplate}>
            {children}
          </AlertProvider>
        </AccountProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}

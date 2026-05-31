import { useEffect, useState } from "react";
import type { Address } from "viem";
import { VARA_ETH_CHAIN_ID } from "../lib/config";
import { getEvmProviderLabel, getPreferredEvmProvider } from "../lib/evmProvider";
import type { WalletStatus } from "./useWalletStatus";

function formatAddress(address: string) {
  return `EVM • ${address.slice(0, 6)}…${address.slice(-4)}`;
}

function hexChainIdToNumber(value: string | null) {
  if (!value) {
    return 0;
  }

  return Number.parseInt(value, 16);
}

export function useVaraEthWalletStatus(): WalletStatus & { address: Address | null; providerLabel: string | null } {
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState(0);
  const [hasProvider, setHasProvider] = useState(false);
  const [providerLabel, setProviderLabel] = useState<string | null>(null);

  useEffect(() => {
    const provider = getPreferredEvmProvider();
    setHasProvider(Boolean(provider));
    setProviderLabel(getEvmProviderLabel(provider));
    if (!provider) {
      setAccount(null);
      setChainId(0);
      return;
    }

    let cancelled = false;
    const sync = async () => {
      try {
        const [accounts, nextChainId] = await Promise.all([
          provider.request({ method: "eth_accounts" }) as Promise<string[]>,
          provider.request({ method: "eth_chainId" }) as Promise<string>
        ]);
        if (cancelled) {
          return;
        }

        const nextAccount = accounts[0] as Address | undefined;
        setAccount(nextAccount ?? null);
        setChainId(hexChainIdToNumber(nextChainId));
      } catch {
        if (!cancelled) {
          setAccount(null);
        }
      }
    };

    const handleAccountsChanged = (accounts: unknown) => {
      const nextAccounts = Array.isArray(accounts) ? accounts as string[] : [];
      setAccount((nextAccounts[0] as Address | undefined) ?? null);
    };
    const handleChainChanged = (value: unknown) => {
      setChainId(typeof value === "string" ? hexChainIdToNumber(value) : 0);
    };

    void sync();
    provider.on?.("accountsChanged", handleAccountsChanged);
    provider.on?.("chainChanged", handleChainChanged);

    return () => {
      cancelled = true;
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
    };
  }, []);

  async function connect() {
    const provider = getPreferredEvmProvider();
    if (!provider) {
      return;
    }

    if (VARA_ETH_CHAIN_ID > 0 && chainId > 0 && chainId !== VARA_ETH_CHAIN_ID) {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${VARA_ETH_CHAIN_ID.toString(16)}` }]
      });
    }

    const [nextAccount] = await (provider.request({ method: "eth_requestAccounts" }) as Promise<string[]>);
    const nextChainId = await (provider.request({ method: "eth_chainId" }) as Promise<string>);
    setAccount((nextAccount as Address | undefined) ?? null);
    setChainId(hexChainIdToNumber(nextChainId));
  }

  function disconnect() {
    setAccount(null);
  }

  if (!hasProvider) {
    return {
      accountLabel: null,
      address: null,
      connectLabel: "Install Wallet",
      disabledReason: "No EVM wallet was found. Install MetaMask, Rabby, or another EIP-1193 wallet.",
      isConnected: false,
      isReady: false,
      providerLabel,
      connect,
      disconnect
    };
  }

  if (VARA_ETH_CHAIN_ID > 0 && chainId > 0 && chainId !== VARA_ETH_CHAIN_ID) {
    return {
      accountLabel: account ? formatAddress(account) : null,
      address: account,
      connectLabel: "Switch Network",
      disabledReason: `Switch ${providerLabel ?? "your EVM wallet"} to chain ${VARA_ETH_CHAIN_ID} to use Vara.eth.`,
      isConnected: Boolean(account),
      isReady: true,
      providerLabel,
      connect,
      disconnect
    };
  }

  if (!account) {
    return {
      accountLabel: null,
      address: null,
      connectLabel: "Connect EVM Wallet",
      disabledReason: providerLabel
        ? `${providerLabel} is selected, but no address is connected yet.`
        : "An EVM wallet is available, but no address is connected yet.",
      isConnected: false,
      isReady: true,
      providerLabel,
      connect,
      disconnect
    };
  }

  return {
    accountLabel: formatAddress(account),
    address: account,
    connectLabel: "Wallet Connected",
    disabledReason: null,
    isConnected: true,
    isReady: true,
    providerLabel,
    connect,
    disconnect
  };
}

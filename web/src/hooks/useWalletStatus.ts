import { useAccount } from "@gear-js/react-hooks";

export type WalletStatus = {
  accountLabel: string | null;
  connectLabel: string;
  disabledReason: string | null;
  isConnected: boolean;
  isReady: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
};

export function useWalletStatus(): WalletStatus {
  const { account, isAccountReady, isAnyWallet, login, logout, wallets } = useAccount();

  async function connect() {
    if (!wallets || !Object.keys(wallets).length) {
      return;
    }

    const [firstWallet] = Object.values(wallets);
    if (!firstWallet) {
      return;
    }

    if (!firstWallet.accounts?.length) {
      await firstWallet.connect();
    }

    const selected = firstWallet.accounts?.[0];
    if (selected) {
      login(selected);
    }
  }

  function disconnect() {
    logout();
  }

  if (!isAccountReady) {
    return {
      accountLabel: null,
      connectLabel: "Loading Wallets",
      disabledReason: "Wallet discovery is still loading.",
      isConnected: false,
      isReady: false,
      connect,
      disconnect
    };
  }

  if (!isAnyWallet) {
    return {
      accountLabel: null,
      connectLabel: "Install Wallet",
      disabledReason: "No Vara-compatible wallet extension was found.",
      isConnected: false,
      isReady: false,
      connect,
      disconnect
    };
  }

  if (!account) {
    return {
      accountLabel: null,
      connectLabel: "Connect Wallet",
      disabledReason: "A wallet extension exists, but no account is connected yet.",
      isConnected: false,
      isReady: true,
      connect,
      disconnect
    };
  }

  return {
    accountLabel: `${account.meta.name ?? "Wallet"} • ${account.address.slice(0, 6)}…${account.address.slice(-4)}`,
    connectLabel: "Wallet Connected",
    disabledReason: null,
    isConnected: true,
    isReady: true,
    connect,
    disconnect
  };
}

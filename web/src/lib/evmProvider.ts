export type Eip1193Provider = {
  isBraveWallet?: boolean;
  isCoinbaseWallet?: boolean;
  isMetaMask?: boolean;
  isPhantom?: boolean;
  isRabby?: boolean;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  providers?: Eip1193Provider[];
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

function dedupeProviders(providers: Eip1193Provider[]) {
  return providers.filter((provider, index) => providers.indexOf(provider) === index);
}

export function getInjectedEvmProviders() {
  if (typeof window === "undefined" || !window.ethereum) {
    return [];
  }

  const providers = Array.isArray(window.ethereum.providers) && window.ethereum.providers.length > 0
    ? window.ethereum.providers
    : [window.ethereum];

  return dedupeProviders(providers);
}

export function getPreferredEvmProvider() {
  const providers = getInjectedEvmProviders();
  if (providers.length === 0) {
    return null;
  }

  return providers.find((provider) => provider.isRabby)
    ?? providers.find((provider) => provider.isMetaMask && !provider.isPhantom)
    ?? providers.find((provider) => provider.isCoinbaseWallet)
    ?? providers.find((provider) => provider.isBraveWallet)
    ?? providers.find((provider) => !provider.isPhantom)
    ?? providers[0]
    ?? null;
}

export function getEvmProviderLabel(provider: Eip1193Provider | null) {
  if (!provider) {
    return null;
  }
  if (provider.isRabby) {
    return "Rabby";
  }
  if (provider.isMetaMask && !provider.isPhantom) {
    return "MetaMask";
  }
  if (provider.isCoinbaseWallet) {
    return "Coinbase Wallet";
  }
  if (provider.isBraveWallet) {
    return "Brave Wallet";
  }
  if (provider.isPhantom) {
    return "Phantom";
  }
  return "EVM Wallet";
}

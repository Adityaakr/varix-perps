import { Keyring } from "@polkadot/keyring";
import { u8aToHex } from "@polkadot/util";
import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";

const SESSION_STORAGE_PREFIX = "varix.session-signer";

type StoredSessionSigner = {
  actorId: string;
  address: string;
  createdAt: number;
  mnemonic: string;
};

function storageKey(owner: string) {
  return `${SESSION_STORAGE_PREFIX}:${owner}`;
}

async function createPair(mnemonic: string) {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  return keyring.addFromUri(mnemonic);
}

export async function getOrCreateSessionSigner(owner: string) {
  if (typeof window === "undefined") {
    throw new Error("session signer is only available in the browser");
  }

  const key = storageKey(owner);
  const existing = window.localStorage.getItem(key);
  if (existing) {
    const parsed = JSON.parse(existing) as StoredSessionSigner;
    const pair = await createPair(parsed.mnemonic);
    return { ...parsed, pair };
  }

  const mnemonic = mnemonicGenerate();
  const pair = await createPair(mnemonic);
  const signer: StoredSessionSigner = {
    actorId: u8aToHex(pair.addressRaw),
    address: pair.address,
    createdAt: Date.now(),
    mnemonic
  };
  window.localStorage.setItem(key, JSON.stringify(signer));
  return { ...signer, pair };
}

export async function loadSessionSigner(owner: string) {
  if (typeof window === "undefined") {
    return null;
  }

  const existing = window.localStorage.getItem(storageKey(owner));
  if (!existing) {
    return null;
  }

  const parsed = JSON.parse(existing) as StoredSessionSigner;
  const pair = await createPair(parsed.mnemonic);
  return { ...parsed, pair };
}

export function clearSessionSigner(owner: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(storageKey(owner));
}

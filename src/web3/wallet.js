import { getAddress } from "ethers";

const SEPOLIA_CHAIN_ID = 11155111;
const FALLBACK_CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || SEPOLIA_CHAIN_ID);

// ─── EIP-6963 wallet discovery ──────────────────────────────────────────────
// Every installed wallet announces itself, so we can list them by name/icon and
// let the player pick — instead of blindly grabbing window.ethereum (which only
// ever exposes one wallet and breaks when several are installed). We keep the
// provider the user picked as `activeProvider` and route every request through
// it so mints/signatures always use the chosen wallet.
const discovered = new Map(); // rdns -> { info, provider }
let activeProvider = null;

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const { info, provider } = event.detail || {};
    if (info?.rdns && provider) discovered.set(info.rdns, { info, provider });
  });
  // Ask wallets that loaded before us to (re)announce.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function hasInjectedWallet() {
  return typeof window !== "undefined" && (discovered.size > 0 || Boolean(window.ethereum));
}

// Snapshot of connectable wallets for the picker. Falls back to a generic
// injected provider when nothing announced (older wallets / no EIP-6963).
export function listWallets() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  }
  const wallets = [...discovered.values()].map(({ info, provider }) => ({
    id: info.rdns,
    name: info.name,
    icon: info.icon,
    provider
  }));
  if (wallets.length === 0 && typeof window !== "undefined" && window.ethereum) {
    wallets.push({ id: "injected", name: "Browser Wallet", icon: null, provider: window.ethereum });
  }
  return wallets;
}

// The provider the rest of the app should talk to. Defaults to window.ethereum
// until the user explicitly picks one.
export function getActiveProvider() {
  if (activeProvider) return activeProvider;
  if (typeof window !== "undefined" && window.ethereum) return window.ethereum;
  return null;
}

export function clearActiveProvider() {
  activeProvider = null;
}

export async function connectWallet(walletOrProvider) {
  const provider = walletOrProvider?.provider || walletOrProvider || getActiveProvider();
  if (!provider) {
    throw new Error("No wallet found. Install MetaMask (or another browser wallet) to connect.");
  }
  activeProvider = provider;

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!accounts?.length) throw new Error("No account authorized.");

  await ensureChain(FALLBACK_CHAIN_ID);
  return { address: getAddress(accounts[0]), provider };
}

// Silent reconnect on page load — returns the address only if the wallet has
// already authorized this site, without popping the wallet UI.
export async function getConnectedAccount() {
  const provider = getActiveProvider();
  if (!provider) return null;
  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    if (accounts?.length) {
      activeProvider = provider;
      return getAddress(accounts[0]);
    }
  } catch {
    // ignore — treat as not connected
  }
  return null;
}

export async function signMessage(message, address) {
  const provider = getActiveProvider();
  if (!provider) throw new Error("Connect a wallet first.");
  return provider.request({ method: "personal_sign", params: [message, address] });
}

export async function ensureChain(chainId = FALLBACK_CHAIN_ID) {
  const provider = getActiveProvider();
  if (!provider) throw new Error("No wallet found.");
  const hexChainId = `0x${chainId.toString(16)}`;

  // Skip the round-trip when already on the right chain (eth_chainId is instant,
  // wallet_switchEthereumChain is not).
  try {
    const current = await provider.request({ method: "eth_chainId" });
    if (current?.toLowerCase() === hexChainId.toLowerCase()) return;
  } catch {
    // fall through to an explicit switch
  }

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChainId }]
    });
  } catch (error) {
    // 4902 = chain not added yet → add it (Sepolia only), then it's selected.
    if (error?.code !== 4902 || chainId !== SEPOLIA_CHAIN_ID) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hexChainId,
          chainName: "Sepolia",
          nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://rpc.sepolia.org"],
          blockExplorerUrls: ["https://sepolia.etherscan.io"]
        }
      ]
    });
  }
}

// Subscribe to wallet account/chain changes. Returns an unsubscribe fn.
export function watchWallet({ onAccountsChanged, onChainChanged } = {}) {
  const provider = getActiveProvider();
  if (!provider?.on) return () => {};
  const accounts = (accs) => onAccountsChanged?.(accs?.length ? getAddress(accs[0]) : null);
  const chain = (cid) => onChainChanged?.(cid);
  provider.on("accountsChanged", accounts);
  provider.on("chainChanged", chain);
  return () => {
    provider.removeListener?.("accountsChanged", accounts);
    provider.removeListener?.("chainChanged", chain);
  };
}

export function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
}

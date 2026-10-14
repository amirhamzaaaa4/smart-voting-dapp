import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BrowserProvider, JsonRpcProvider, toQuantity, type AbstractProvider, type Signer } from "ethers";
import { DEPLOYMENT, IS_LOCAL, RPC_URL } from "./contract";

type Mode = "injected" | "dev";

interface WalletState {
  /** Provider for reads; works before any wallet is connected. */
  readProvider: AbstractProvider | null;
  signer: Signer | null;
  account: string | null;
  mode: Mode | null;
  wrongNetwork: boolean;
  hasInjected: boolean;
  connectInjected: () => Promise<void>;
  connectDev: (index: number) => Promise<void>;
  disconnect: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<any>;
  on?: any;
  removeListener?: any;
};
const injected = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [signer, setSigner] = useState<Signer | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);

  const rpcProvider = useMemo(
    () => (RPC_URL ? new JsonRpcProvider(RPC_URL, DEPLOYMENT.chainId, { staticNetwork: true }) : null),
    [],
  );
  const browserProvider = useMemo(() => (injected() ? new BrowserProvider(injected()!) : null), []);
  const readProvider: AbstractProvider | null = rpcProvider ?? browserProvider;

  const disconnect = useCallback(() => {
    setSigner(null);
    setAccount(null);
    setMode(null);
    setWalletChainId(null);
  }, []);

  const connectInjected = useCallback(async () => {
    const eth = injected();
    if (!eth) throw new Error("No browser wallet found. Install MetaMask or a compatible wallet.");
    await eth.request({ method: "eth_requestAccounts" });
    const target = toQuantity(DEPLOYMENT.chainId);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target }] });
    } catch {
      /* user declined or chain unknown; surfaced via wrongNetwork */
    }
    const provider = new BrowserProvider(eth);
    const s = await provider.getSigner();
    setSigner(s);
    setAccount(await s.getAddress());
    setWalletChainId(Number((await provider.getNetwork()).chainId));
    setMode("injected");
  }, []);

  /** Local demo only: use one of Hardhat's unlocked accounts, no wallet extension needed. */
  const connectDev = useCallback(
    async (index: number) => {
      if (!IS_LOCAL || !rpcProvider) throw new Error("Demo accounts are only available on a local chain.");
      const s = await (rpcProvider as JsonRpcProvider).getSigner(index);
      setSigner(s);
      setAccount(await s.getAddress());
      setWalletChainId(DEPLOYMENT.chainId);
      setMode("dev");
    },
    [rpcProvider],
  );

  // Local demo deep link: `?demo=3` opens the app already connected as Hardhat account #3.
  useEffect(() => {
    const demo = new URLSearchParams(window.location.search).get("demo");
    if (IS_LOCAL && demo !== null && /^\d{1,2}$/.test(demo)) connectDev(Number(demo)).catch(() => {});
  }, [connectDev]);

  // Follow account / network switches made inside the wallet.
  useEffect(() => {
    const eth = injected();
    if (!eth?.on || mode !== "injected") return;
    const onAccounts = (accounts: string[]) => (accounts.length ? connectInjected() : disconnect());
    const onChain = (id: string) => setWalletChainId(Number(id));
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [mode, connectInjected, disconnect]);

  const value: WalletState = {
    readProvider,
    signer,
    account,
    mode,
    wrongNetwork: walletChainId !== null && walletChainId !== DEPLOYMENT.chainId,
    hasInjected: !!injected(),
    connectInjected,
    connectDev,
    disconnect,
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}

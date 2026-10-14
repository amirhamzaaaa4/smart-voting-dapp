import { useState } from "react";
import { DEPLOYMENT, IS_LOCAL, describeError } from "../lib/contract";
import { shortAddress } from "../lib/format";
import type { Roles } from "../lib/hooks";
import { useWallet } from "../lib/wallet";
import { useToast } from "./Toasts";

const NETWORK_NAMES: Record<number, string> = {
  1: "Ethereum",
  11155111: "Sepolia",
  31337: "Local Hardhat",
};

export function Header({ route, roles, paused }: { route: string; roles: Roles; paused: boolean }) {
  const { account, mode, wrongNetwork, hasInjected, connectInjected, connectDev, disconnect } = useWallet();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setMenuOpen(false);
    try {
      await fn();
    } catch (err) {
      toast("error", "Could not connect", describeError(err));
    }
  };

  const canAdmin = roles.isElectionAdmin || roles.isPauser || roles.isAdmin;

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <a href="#/" className="brand">
            <span className="brand-mark" aria-hidden>
              <svg viewBox="0 0 32 32">
                <path d="M9 16.5l4.5 4.5L23 11.5" />
              </svg>
            </span>
            SmartVoting
          </a>

          <nav className="nav">
            <a href="#/" className={route === "/" || route.startsWith("/election") ? "active" : ""}>
              Elections
            </a>
            {canAdmin && (
              <a href="#/admin" className={route === "/admin" ? "active" : ""}>
                Admin
              </a>
            )}
            <a href="#/about" className={route === "/about" ? "active" : ""}>
              How it works
            </a>
          </nav>

          <div className="header-actions">
            <span className="chip chip-network" title={DEPLOYMENT.address}>
              <span className="dot" /> {NETWORK_NAMES[DEPLOYMENT.chainId] ?? `Chain ${DEPLOYMENT.chainId}`}
            </span>

            {account ? (
              <div className="account">
                <span className="chip chip-account" title={account}>
                  {mode === "dev" ? "Demo · " : ""}
                  {shortAddress(account)}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={disconnect}>
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="connect">
                <button className="btn btn-primary btn-sm" onClick={() => setMenuOpen((o) => !o)}>
                  Connect
                </button>
                {menuOpen && (
                  <div className="menu" role="menu">
                    <button role="menuitem" disabled={!hasInjected} onClick={() => run(connectInjected)}>
                      Browser wallet
                      <small>{hasInjected ? "MetaMask, Rabby, Coinbase…" : "No wallet extension detected"}</small>
                    </button>
                    {IS_LOCAL && (
                      <>
                        <div className="menu-label">Local demo accounts</div>
                        {[0, 1, 2, 3, 4, 5, 6, 10].map((i) => (
                          <button key={i} role="menuitem" onClick={() => run(() => connectDev(i))}>
                            Account #{i}
                            <small>
                              {i === 0 ? "Admin (all roles)" : i < 10 ? "On the allowlist" : "Not on the allowlist"}
                            </small>
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {paused && (
        <div className="banner banner-warn">
          Voting is paused by an administrator. Deadlines continue to run; actions resume when the system is unpaused.
        </div>
      )}
      {wrongNetwork && (
        <div className="banner banner-error">
          Your wallet is on the wrong network. Switch to {NETWORK_NAMES[DEPLOYMENT.chainId] ?? DEPLOYMENT.chainId} to
          vote.
        </div>
      )}
    </>
  );
}

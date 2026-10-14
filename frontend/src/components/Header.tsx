import { useState } from "react";
import { DEPLOYMENT, IS_DEMO, IS_LOCAL, describeError } from "../lib/contract";
import { shortAddress } from "../lib/format";
import type { Roles } from "../lib/hooks";
import { useWallet } from "../lib/wallet";
import { useToast } from "./Toasts";

const NETWORK_NAMES: Record<number, string> = {
  1: "Ethereum",
  11155111: "Sepolia",
  31337: "Local Hardhat",
};

const DEMO_ACCOUNTS = IS_DEMO ? [6, 7, 8, 9, 0, 1, 10, 11] : [0, 1, 2, 3, 4, 5, 6, 10];

function accountHint(i: number) {
  if (i === 0) return "Admin (all roles)";
  if (IS_DEMO && i >= 6 && i <= 9) return "Fresh voter · on the allowlist";
  return i < 10 ? "On the allowlist" : "Not on the allowlist";
}

interface HeaderProps {
  route: string;
  roles: Roles;
  paused: boolean;
  refresh: () => Promise<void>;
}

export function Header({ route, roles, paused, refresh }: HeaderProps) {
  const { account, mode, wrongNetwork, hasInjected, connectInjected, connectDev, disconnect } = useWallet();
  const toast = useToast();
  const [menuOpen, setMenuOpen] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const skipDay = async () => {
    setSkipping(true);
    try {
      const { getDemo } = await import("../demo/bootstrap");
      await (await getDemo()).skipTime(24 * 3600);
      await refresh();
      toast("info", "Skipped ahead 1 day", "Deadlines and reveal windows move forward on the demo chain.");
    } finally {
      setSkipping(false);
    }
  };

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
              <span className="dot" />{" "}
              {IS_DEMO ? "In-browser chain" : (NETWORK_NAMES[DEPLOYMENT.chainId] ?? `Chain ${DEPLOYMENT.chainId}`)}
            </span>

            <div className="connect">
              {account ? (
                <div className="account">
                  <span className="chip chip-account" title={account}>
                    {mode === "dev" ? "Demo · " : ""}
                    {shortAddress(account)}
                  </span>
                  {IS_DEMO ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => setMenuOpen((o) => !o)}>
                      Switch account
                    </button>
                  ) : (
                    <button className="btn btn-ghost btn-sm" onClick={disconnect}>
                      Disconnect
                    </button>
                  )}
                </div>
              ) : (
                <button className="btn btn-primary btn-sm" onClick={() => setMenuOpen((o) => !o)}>
                  Connect
                </button>
              )}
              {menuOpen && (
                <div className="menu" role="menu">
                  {!IS_DEMO && (
                    <button role="menuitem" disabled={!hasInjected} onClick={() => run(connectInjected)}>
                      Browser wallet
                      <small>{hasInjected ? "MetaMask, Rabby, Coinbase…" : "No wallet extension detected"}</small>
                    </button>
                  )}
                  {IS_LOCAL && (
                    <>
                      <div className="menu-label">{IS_DEMO ? "Demo accounts" : "Local demo accounts"}</div>
                      {DEMO_ACCOUNTS.map((i) => (
                        <button key={i} role="menuitem" onClick={() => run(() => connectDev(i))}>
                          Account #{i}
                          <small>{accountHint(i)}</small>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {IS_DEMO && (
        <div className="banner banner-demo">
          <span>
            <strong>Live demo</strong>: the real smart contract runs on an Ethereum VM inside your browser. No wallet or
            crypto needed. You start as a fresh voter; use <em>Switch account</em> to try others (#0 is the admin).
          </span>
          <span className="banner-actions">
            <button className="btn btn-secondary btn-sm" disabled={skipping} onClick={skipDay}>
              ⏩ Skip 1 day
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => window.location.reload()}>
              ↺ Reset demo
            </button>
          </span>
        </div>
      )}
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

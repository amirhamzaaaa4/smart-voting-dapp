import { useCallback, useEffect, useRef, useState } from "react";
import { getManager, toElection, ROLES, type Election } from "./contract";
import { useWallet } from "./wallet";

const POLL_MS = 4000;

/** Seconds on the chain's clock, ticking locally between polls (local chains can be time-travelled). */
export function useChainClock(chainTime: number | null) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const anchor = useRef({ chain: 0, wall: 0 });

  useEffect(() => {
    if (chainTime !== null) anchor.current = { chain: chainTime, wall: Date.now() };
  }, [chainTime]);

  useEffect(() => {
    const t = setInterval(() => {
      const { chain, wall } = anchor.current;
      setNow(chain ? chain + Math.floor((Date.now() - wall) / 1000) : Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  return now;
}

export interface PlatformState {
  elections: Election[];
  paused: boolean;
  chainTime: number | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePlatform(): PlatformState {
  const { readProvider } = useWallet();
  const [state, setState] = useState<Omit<PlatformState, "refresh">>({
    elections: [],
    paused: false,
    chainTime: null,
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    if (!readProvider) {
      setState((s) => ({ ...s, loading: false, error: "No RPC endpoint or wallet available." }));
      return;
    }
    try {
      const manager = getManager(readProvider);
      const [count, paused, block] = await Promise.all([
        manager.electionCount(),
        manager.paused(),
        readProvider.getBlock("latest"),
      ]);
      const raw = Number(count) > 0 ? await manager.getElections(0, count) : [];
      setState({
        elections: raw.map(toElection),
        paused,
        chainTime: block?.timestamp ?? null,
        loading: false,
        error: null,
      });
    } catch (err) {
      console.error(err);
      setState((s) => ({
        ...s,
        loading: false,
        error: "Could not reach the blockchain. Is the node running and the contract deployed?",
      }));
    }
  }, [readProvider]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return { ...state, refresh };
}

export interface Roles {
  isAdmin: boolean;
  isElectionAdmin: boolean;
  isPauser: boolean;
}

export function useRoles(): Roles {
  const { readProvider, account } = useWallet();
  const [roles, setRoles] = useState<Roles>({ isAdmin: false, isElectionAdmin: false, isPauser: false });

  useEffect(() => {
    if (!readProvider || !account) {
      setRoles({ isAdmin: false, isElectionAdmin: false, isPauser: false });
      return;
    }
    const manager = getManager(readProvider);
    Promise.all([
      manager.hasRole(ROLES.DEFAULT_ADMIN, account),
      manager.hasRole(ROLES.ELECTION_ADMIN, account),
      manager.hasRole(ROLES.PAUSER, account),
    ])
      .then(([isAdmin, isElectionAdmin, isPauser]) => setRoles({ isAdmin, isElectionAdmin, isPauser }))
      .catch(() => setRoles({ isAdmin: false, isElectionAdmin: false, isPauser: false }));
  }, [readProvider, account]);

  return roles;
}

/** Minimal hash router: #/ , #/election/3 , #/admin */
export function useRoute() {
  const read = () => window.location.hash.replace(/^#/, "") || "/";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onHash = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

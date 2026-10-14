import { Contract, Interface, ZeroHash, id, type ContractRunner } from "ethers";
import deployment from "../contracts/deployment.json";
import abi from "../contracts/ElectionManager.abi.json";

/**
 * Live-demo build (`vite --mode demo`): the app runs its own Ethereum VM in the
 * browser (see src/demo) instead of connecting to a node, so anyone can try it.
 */
export const IS_DEMO = import.meta.env.VITE_DEMO === "true";

export const LOCAL_CHAIN_ID = 31337;

export const DEPLOYMENT = (
  IS_DEMO
    ? {
        chainId: LOCAL_CHAIN_ID,
        network: "demo",
        // First contract deployed by Hardhat account #0 (deterministic CREATE address).
        address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        deployBlock: 0,
      }
    : deployment
) as {
  chainId: number;
  network: string;
  address: string;
  deployBlock: number;
};

export const ELECTION_ABI = abi;
export const electionInterface = new Interface(abi);

export const IS_LOCAL = DEPLOYMENT.chainId === LOCAL_CHAIN_ID;

export const RPC_URL: string | undefined = IS_DEMO
  ? undefined
  : import.meta.env.VITE_RPC_URL || (IS_LOCAL ? "http://127.0.0.1:8545" : undefined);
export const RELAYER_URL: string | undefined = IS_DEMO
  ? undefined
  : import.meta.env.VITE_RELAYER_URL || (IS_LOCAL ? "http://127.0.0.1:8787" : undefined);

export const ROLES = {
  DEFAULT_ADMIN: ZeroHash,
  ELECTION_ADMIN: id("ELECTION_ADMIN_ROLE"),
  PAUSER: id("PAUSER_ROLE"),
} as const;

export function getManager(runner: ContractRunner) {
  return new Contract(DEPLOYMENT.address, ELECTION_ABI, runner);
}

export enum Status {
  Pending = 0,
  Active = 1,
  Revealing = 2,
  Ended = 3,
}

export enum Outcome {
  NoVotes = 0,
  Winner = 1,
  Tie = 2,
}

export const STATUS_LABEL: Record<Status, string> = {
  [Status.Pending]: "Upcoming",
  [Status.Active]: "Voting open",
  [Status.Revealing]: "Revealing",
  [Status.Ended]: "Ended",
};

export interface Election {
  id: number;
  title: string;
  creator: string;
  startTime: number;
  endTime: number;
  revealEndTime: number;
  secret: boolean;
  closedEarly: boolean;
  cancelled: boolean;
  voterRoot: string;
  totalCommits: number;
  totalVotes: number;
  status: Status;
  proposalNames: string[];
  voteCounts: number[];
}

export const ZERO_ROOT = ZeroHash;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toElection(r: any): Election {
  return {
    id: Number(r.id),
    title: r.title,
    creator: r.creator,
    startTime: Number(r.startTime),
    endTime: Number(r.endTime),
    revealEndTime: Number(r.revealEndTime),
    secret: r.secret,
    closedEarly: r.closedEarly,
    cancelled: r.cancelled,
    voterRoot: r.voterRoot,
    totalCommits: Number(r.totalCommits),
    totalVotes: Number(r.totalVotes),
    status: Number(r.status) as Status,
    proposalNames: [...r.proposalNames],
    voteCounts: [...r.voteCounts].map(Number),
  };
}

/** Status computed against a (ticking) clock, mirroring ElectionManager._status. */
export function liveStatus(e: Election, now: number): Status {
  if (e.cancelled) return Status.Ended;
  if (now < e.startTime) return Status.Pending;
  if (now < e.endTime) return Status.Active;
  if (now < e.revealEndTime) return Status.Revealing;
  return Status.Ended;
}

export function outcomeOf(e: Election): { outcome: Outcome; winner?: number } {
  if (e.totalVotes === 0) return { outcome: Outcome.NoVotes };
  const top = Math.max(...e.voteCounts);
  const leaders = e.voteCounts.filter((c) => c === top).length;
  return leaders > 1 ? { outcome: Outcome.Tie } : { outcome: Outcome.Winner, winner: e.voteCounts.indexOf(top) };
}

const FRIENDLY_ERRORS: Record<string, string> = {
  AlreadyVoted: "This address has already voted in this election.",
  NotEligible: "This address is not on the election's voter allowlist.",
  InvalidProposal: "That option does not exist.",
  WrongStatus: "This action is not available in the election's current phase.",
  WrongBallotType: "This action does not apply to this type of ballot.",
  ElectionNotFound: "Election not found.",
  ElectionNotEnded: "Results are final only once the election has ended.",
  CommitmentMismatch: "The choice and secret do not match your sealed vote.",
  NoCommitment: "No sealed vote was found for this address.",
  AlreadyRevealed: "Your vote has already been revealed.",
  EmptyCommitment: "Commitment cannot be empty.",
  SignatureExpired: "The signature has expired. Please sign again.",
  InvalidSignature: "The signature is not valid for this vote.",
  InvalidTitle: "Title must be between 1 and 128 characters.",
  InvalidProposalCount: "Elections need between 2 and 20 options.",
  EmptyProposalName: "Option names cannot be empty.",
  InvalidSchedule: "End time must be after the start time and within one year.",
  InvalidRevealDuration: "Reveal window can be at most 30 days.",
  EnforcedPause: "The system is paused by an administrator.",
  AccessControlUnauthorizedAccount: "Your account does not have permission for this action.",
};

/** Turns wallet / RPC / custom-error noise into a sentence a user can act on. */
export function describeError(err: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  if (e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001) return "Request rejected in wallet.";

  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? e?.revert?.data;
  const name = e?.revert?.name ?? (typeof data === "string" ? safeParse(data) : undefined);
  if (name) return FRIENDLY_ERRORS[name] ?? name;

  const reason = e?.reason ?? e?.shortMessage ?? e?.message;
  return typeof reason === "string" ? reason.replace(/\(action=.*$/, "").trim() : "Something went wrong.";
}

function safeParse(data: string) {
  try {
    return electionInterface.parseError(data)?.name;
  } catch {
    return undefined;
  }
}

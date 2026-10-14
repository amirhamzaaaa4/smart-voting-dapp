import { hexlify, randomBytes, type Signer } from "ethers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { DEPLOYMENT, RELAYER_URL, ZERO_ROOT, getManager } from "./contract";

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

export interface Allowlist {
  root: string;
  voters: Record<string, string[]>;
}

const allowlistCache = new Map<string, Promise<Allowlist | null>>();

/** Fetches the published proofs for a Merkle root (frontend/public/allowlists/<root>.json). */
export function loadAllowlist(root: string): Promise<Allowlist | null> {
  if (root === ZERO_ROOT) return Promise.resolve(null);
  if (!allowlistCache.has(root)) {
    allowlistCache.set(
      root,
      fetch(`./allowlists/${root}.json`)
        .then((r) => (r.ok ? (r.json() as Promise<Allowlist>) : null))
        .catch(() => null),
    );
  }
  return allowlistCache.get(root)!;
}

export function proofFor(list: Allowlist | null, account: string): string[] | null {
  if (!list) return null;
  const key = Object.keys(list.voters).find((a) => a.toLowerCase() === account.toLowerCase());
  return key ? list.voters[key] : null;
}

/** Builds an allowlist in the browser (same leaf format as the contract and scripts/build-allowlist.js). */
export function buildAllowlist(addresses: string[]): Allowlist {
  const tree = StandardMerkleTree.of(
    addresses.map((a) => [a]),
    ["address"],
  );
  const voters: Record<string, string[]> = {};
  for (const [i, [address]] of tree.entries()) voters[address as string] = tree.getProof(i);
  return { root: tree.root, voters };
}

export function downloadJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Secret ballots: the salt never leaves the voter's device until reveal.
// ---------------------------------------------------------------------------

export interface SealedVote {
  electionId: number;
  proposalIndex: number;
  salt: string;
  voter: string;
  contract: string;
  chainId: number;
}

const sealedKey = (electionId: number, voter: string) =>
  `smartvoting:sealed:${DEPLOYMENT.chainId}:${DEPLOYMENT.address}:${electionId}:${voter.toLowerCase()}`;

export function newSalt() {
  return hexlify(randomBytes(32));
}

export function saveSealedVote(v: SealedVote) {
  try {
    localStorage.setItem(sealedKey(v.electionId, v.voter), JSON.stringify(v));
  } catch {
    /* storage unavailable: the downloaded receipt is the backup */
  }
}

export function loadSealedVote(electionId: number, voter: string): SealedVote | null {
  try {
    const raw = localStorage.getItem(sealedKey(electionId, voter));
    return raw ? (JSON.parse(raw) as SealedVote) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gasless voting (EIP-712 + relayer)
// ---------------------------------------------------------------------------

const VOTE_TYPES = {
  Vote: [
    { name: "electionId", type: "uint256" },
    { name: "proposalIndex", type: "uint256" },
    { name: "voter", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

export const relayerAvailable = () => !!RELAYER_URL;

export async function voteGasless(signer: Signer, electionId: number, proposalIndex: number, proof: string[]) {
  if (!RELAYER_URL) throw new Error("No relayer configured.");
  const manager = getManager(signer);
  const voter = await signer.getAddress();

  // ERC-5267: read the exact EIP-712 domain from the contract instead of hard-coding it.
  const [, name, version, chainId, verifyingContract] = await manager.eip712Domain();
  const nonce = await manager.nonces(voter);
  const deadline = Math.floor(Date.now() / 1000) + 15 * 60;

  const signature = await signer.signTypedData({ name, version, chainId, verifyingContract }, VOTE_TYPES, {
    electionId,
    proposalIndex,
    voter,
    nonce,
    deadline,
  });

  const res = await fetch(`${RELAYER_URL}/relay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      electionId: String(electionId),
      proposalIndex: String(proposalIndex),
      voter,
      deadline: String(deadline),
      proof,
      signature,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(new Error(body.error || `Relayer error (${res.status})`), { revert: { name: body.error } });
  return body.txHash as string;
}

// Boots the public live demo: starts the in-browser chain, deploys the real
// ElectionManager bytecode, and seeds elections in every lifecycle state, so a
// visitor can explore and vote immediately with no wallet or setup.
import { BrowserProvider, ContractFactory, ZeroHash, id } from "ethers";
import { createInBrowserChain } from "./chain";
import artifact from "../contracts/ElectionManager.bytecode.json";
import { DEPLOYMENT, ELECTION_ABI, getManager } from "../lib/contract";
import { buildAllowlist, registerAllowlist, saveSealedVote } from "../lib/ballot";

const HOUR = 3600;
const DAY = 24 * HOUR;

// Account #6 is left untouched by the seed data: it is the account visitors start as
// (see DEMO_VISITOR_ACCOUNT in lib/wallet.tsx), so it can vote everywhere.
/** The in-browser stand-in for the gasless-vote relayer service. */
export const DEMO_RELAYER_ACCOUNT = 19;

export interface Demo {
  provider: BrowserProvider;
  accounts: string[];
  skipTime(seconds: number): Promise<void>;
}

let demo: Promise<Demo> | null = null;

export function getDemo(): Promise<Demo> {
  return (demo ??= boot());
}

async function boot(): Promise<Demo> {
  const chain = await createInBrowserChain();
  const provider = new BrowserProvider(chain, { chainId: DEPLOYMENT.chainId, name: "demo" });
  const signers = await Promise.all(chain.accounts.map((a) => provider.getSigner(a)));
  const [admin] = signers;

  const deployed = await new ContractFactory(ELECTION_ABI, artifact.bytecode, admin).deploy(admin.address);
  await deployed.waitForDeployment();
  if ((await deployed.getAddress()).toLowerCase() !== DEPLOYMENT.address.toLowerCase()) {
    throw new Error("Demo contract deployed at an unexpected address");
  }

  await seed(provider, signers);

  return {
    provider,
    accounts: chain.accounts,
    async skipTime(seconds) {
      await chain.request({ method: "evm_increaseTime", params: [seconds] });
      await chain.request({ method: "evm_mine", params: [] });
    },
  };
}

type Signers = Awaited<ReturnType<BrowserProvider["getSigner"]>>[];

async function seed(provider: BrowserProvider, signers: Signers) {
  const manager = getManager(signers[0]);
  const now = (await provider.getBlock("latest"))!.timestamp;
  let next = 0;

  const create = async (cfg: Record<string, unknown>) => {
    await (await manager.createElection({ startTime: 0, revealDuration: 0, voterRoot: ZeroHash, ...cfg })).wait();
    return next++;
  };
  const vote = async (election: number, voter: number, choice: number) =>
    (await getManager(signers[voter]).vote(election, choice, [])).wait();

  // 0. Open public ballot with live tallies (the original coursework scenario).
  const fund = await create({
    title: "Campus Sustainability Fund 2026",
    proposalNames: ["Solar Panels", "Water Refill Stations", "Bicycle Repair Hub"],
    endTime: now + 7 * DAY,
  });
  const fundVotes: [number, number][] = [
    [1, 0],
    [2, 0],
    [3, 1],
    [4, 1],
    [5, 2],
    [10, 0],
    [11, 1],
    [12, 0],
    [13, 2],
    [14, 0],
    [15, 1],
    [16, 0],
  ];
  for (const [voter, choice] of fundVotes) await vote(fund, voter, choice);

  // 1. Secret ballot restricted to an allowlist (accounts #0–#9).
  const allowlist = buildAllowlist(signers.slice(0, 10).map((s) => s.address));
  registerAllowlist(allowlist);
  const council = await create({
    title: "Student Council President",
    proposalNames: ["Avery Chen", "Jordan Okafor", "Sam Rivera", "Priya Natarajan"],
    endTime: now + 2 * DAY,
    revealDuration: DAY,
    voterRoot: allowlist.root,
  });
  for (const [voter, choice] of [
    [1, 1],
    [2, 2],
    [4, 1],
    [5, 3],
  ] as const) {
    const salt = id(`demo-salt-${voter}`);
    const s = signers[voter];
    const commitment = await manager.computeCommitment(council, choice, salt, s.address);
    await (await getManager(s).commitVote(council, commitment, allowlist.voters[s.address])).wait();
    // Keep the receipt in this browser so switching to that account lets you reveal it later.
    saveSealedVote({
      electionId: council,
      proposalIndex: choice,
      salt,
      voter: s.address,
      contract: DEPLOYMENT.address,
      chainId: DEPLOYMENT.chainId,
    });
  }

  // 2. Scheduled election that opens tomorrow.
  await create({
    title: "Library Opening Hours",
    proposalNames: ["Keep current hours", "Open until midnight", "Open 24/7 during exams"],
    startTime: now + DAY,
    endTime: now + 8 * DAY,
  });

  // 3. Finished election with a clear winner.
  const ended = await create({
    title: "Orientation Week Theme",
    proposalNames: ["Space Odyssey", "Retro Arcade", "Around the World"],
    endTime: now + DAY,
  });
  for (const [voter, choice] of [
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 0],
    [5, 2],
  ] as const)
    await vote(ended, voter, choice);
  await (await manager.closeElection(ended)).wait();
}

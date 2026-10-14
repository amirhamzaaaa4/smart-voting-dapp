// Property-based tests: random elections are driven against an off-chain
// reference model, and the contract must agree with it after every run.
//
// Invariants checked:
//   I1  sum(voteCounts) == totalVotes
//   I2  totalVotes == number of distinct addresses whose vote/reveal succeeded
//   I3  per-proposal tallies match the reference model exactly
//   I4  getOutcome matches the model (NoVotes / Winner / Tie, index, top votes)
//   I5  no address is ever counted twice (every repeat attempt reverts)
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { createElection, buildAllowlist, commitment, DAY, Outcome } = require("./helpers");

const RUNS = Number(process.env.FUZZ_RUNS || 12);

// Deterministic PRNG (mulberry32) so failures are reproducible from the seed.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function expectedOutcome(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return [Outcome.NoVotes, 0n, 0n];
  const top = Math.max(...counts);
  const leaders = counts.filter((c) => c === top).length;
  return leaders > 1 ? [Outcome.Tie, 0n, BigInt(top)] : [Outcome.Winner, BigInt(counts.indexOf(top)), BigInt(top)];
}

async function wallets(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const w = ethers.Wallet.createRandom().connect(ethers.provider);
    await setBalance(w.address, ethers.parseEther("1"));
    out.push(w);
  }
  return out;
}

describe("ElectionManager invariants (randomised)", function () {
  this.timeout(120_000);

  let manager;
  before(async function () {
    const [admin] = await ethers.getSigners();
    manager = await ethers.deployContract("ElectionManager", [admin.address]);
  });

  for (let run = 0; run < RUNS; run++) {
    const seed = 0xc0ffee + run;
    const secret = run % 2 === 1;

    it(`run ${run} (${secret ? "secret" : "open"} ballot, seed ${seed})`, async function () {
      const rand = rng(seed);
      const proposals = 2 + Math.floor(rand() * 5); // 2..6
      const voters = await wallets(4 + Math.floor(rand() * 10)); // 4..13
      const useAllowlist = rand() < 0.5;
      const list = useAllowlist ? buildAllowlist(voters.slice(0, voters.length - 2).map((v) => v.address)) : null;

      const id = await createElection(manager, {
        proposalNames: Array.from({ length: proposals }, (_, i) => `Option ${i}`),
        revealDuration: secret ? DAY : 0,
        voterRoot: list ? list.root : ethers.ZeroHash,
      });

      const model = new Array(proposals).fill(0);
      const counted = new Set();
      const pendingReveals = [];

      // Each voter makes 1-3 attempts with random (possibly invalid) choices.
      for (const v of voters) {
        const attempts = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < attempts; k++) {
          const choice = Math.floor(rand() * (proposals + 1)); // sometimes out of range
          const proof = list ? list.proofFor(v.address) : [];
          const eligible = !list || proof.length > 0;
          const already = counted.has(v.address) || pendingReveals.some((p) => p.v === v);

          if (secret) {
            const salt = ethers.hexlify(ethers.randomBytes(32));
            const tx = manager.connect(v).commitVote(id, commitment(id, choice, salt, v.address), proof);
            if (!eligible || already) {
              await expect(tx).to.be.reverted;
            } else {
              await tx;
              pendingReveals.push({ v, choice, salt, reveal: rand() < 0.8 });
            }
          } else {
            const tx = manager.connect(v).vote(id, choice, proof);
            if (!eligible || already || choice >= proposals) {
              await expect(tx).to.be.reverted; // I5
            } else {
              await tx;
              model[choice]++;
              counted.add(v.address);
            }
          }
        }
      }

      if (secret) {
        await time.increaseTo((await manager.getElection(id)).endTime);
        for (const p of pendingReveals) {
          if (!p.reveal) continue;
          const tx = manager.connect(p.v).revealVote(id, p.choice, p.salt);
          if (p.choice >= proposals) {
            await expect(tx).to.be.reverted;
          } else {
            await tx;
            model[p.choice]++;
            counted.add(p.v.address);
          }
        }
        await time.increaseTo((await manager.getElection(id)).revealEndTime);
      } else {
        await manager.closeElection(id);
      }

      const e = await manager.getElection(id);
      const onChain = e.voteCounts.map(Number);
      expect(onChain.reduce((a, b) => a + b, 0)).to.equal(Number(e.totalVotes)); // I1
      expect(Number(e.totalVotes)).to.equal(counted.size); // I2
      expect(onChain).to.deep.equal(model); // I3
      expect(await manager.getOutcome(id)).to.deep.equal(expectedOutcome(model)); // I4
    });
  }
});

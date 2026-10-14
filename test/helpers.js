const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");

const PROPOSALS = ["Solar Panels", "Water Refill Stations", "Bicycle Repair Hub"];
const HOUR = 3600;
const DAY = 24 * HOUR;

const Status = { Pending: 0n, Active: 1n, Revealing: 2n, Ended: 3n };
const Outcome = { NoVotes: 0n, Winner: 1n, Tie: 2n };

/** Builds an ElectionConfig with sensible defaults (open, public, 1h, starts now). */
async function config(overrides = {}) {
  const now = await time.latest();
  return {
    title: "Campus Sustainability Fund",
    proposalNames: PROPOSALS,
    startTime: 0,
    endTime: now + HOUR,
    revealDuration: 0,
    voterRoot: ethers.ZeroHash,
    ...overrides,
  };
}

/** Creates an election and returns its ID. */
async function createElection(manager, overrides = {}, signer) {
  const cfg = await config(overrides);
  const contract = signer ? manager.connect(signer) : manager;
  const id = await manager.electionCount();
  await contract.createElection(cfg);
  return id;
}

/** OpenZeppelin StandardMerkleTree over voter addresses, matching the contract's leaf format. */
function buildAllowlist(addresses) {
  const tree = StandardMerkleTree.of(
    addresses.map((a) => [a]),
    ["address"],
  );
  const proofFor = (address) => {
    for (const [i, [a]] of tree.entries()) {
      if (a.toLowerCase() === address.toLowerCase()) return tree.getProof(i);
    }
    return [];
  };
  return { root: tree.root, proofFor };
}

/** Signs an EIP-712 Vote for gasless voting. */
async function signVote(manager, signer, { electionId, proposalIndex, voter, nonce, deadline }) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = {
    name: "SmartVoting ElectionManager",
    version: "1",
    chainId,
    verifyingContract: await manager.getAddress(),
  };
  const types = {
    Vote: [
      { name: "electionId", type: "uint256" },
      { name: "proposalIndex", type: "uint256" },
      { name: "voter", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const value = {
    electionId,
    proposalIndex,
    voter: voter ?? signer.address,
    nonce: nonce ?? (await manager.nonces(voter ?? signer.address)),
    deadline,
  };
  return signer.signTypedData(domain, types, value);
}

/** Same encoding as ElectionManager.computeCommitment. */
function commitment(electionId, proposalIndex, salt, voter) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "bytes32", "address"],
      [electionId, proposalIndex, salt, voter],
    ),
  );
}

module.exports = {
  PROPOSALS,
  HOUR,
  DAY,
  Status,
  Outcome,
  config,
  createElection,
  buildAllowlist,
  signVote,
  commitment,
};

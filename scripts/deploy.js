// Deploys ElectionManager and exports its address + ABI for the dApp.
// On a local chain it also seeds demo elections covering every feature.
//
//   npx hardhat run scripts/deploy.js --network localhost
//   npx hardhat run scripts/deploy.js --network sepolia
const path = require("path");
const hre = require("hardhat");
const { buildAllowlist } = require("./lib/allowlist");
const { FRONTEND_CONTRACTS, writeJson, saveAllowlist } = require("./lib/output");

const { ethers, network, artifacts } = hre;
const HOUR = 3600;
const DAY = 24 * HOUR;
const LOCAL = ["hardhat", "localhost"].includes(network.name);

async function main() {
  const [deployer] = await ethers.getSigners();
  const admin = process.env.ADMIN_ADDRESS || deployer.address;

  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);

  const manager = await ethers.deployContract("ElectionManager", [admin]);
  await manager.waitForDeployment();
  const address = await manager.getAddress();
  const receipt = await manager.deploymentTransaction().wait();
  console.log(`ElectionManager deployed at ${address} (block ${receipt.blockNumber})`);

  const { chainId } = await ethers.provider.getNetwork();
  const { abi, bytecode } = await artifacts.readArtifact("ElectionManager");
  writeJson(path.join(FRONTEND_CONTRACTS, "deployment.json"), {
    chainId: Number(chainId),
    network: network.name,
    address,
    deployBlock: receipt.blockNumber,
  });
  writeJson(path.join(FRONTEND_CONTRACTS, "ElectionManager.abi.json"), abi);
  // Bytecode lets the in-browser live demo deploy the real contract (frontend/src/demo).
  writeJson(path.join(FRONTEND_CONTRACTS, "ElectionManager.bytecode.json"), { bytecode });
  console.log("Exported address and ABI to frontend/src/contracts/");

  if (LOCAL) await seed(manager);

  if (!LOCAL && process.env.ETHERSCAN_API_KEY) {
    console.log("Waiting for confirmations before verification...");
    await manager.deploymentTransaction().wait(5);
    await hre.run("verify:verify", { address, constructorArguments: [admin] });
  }
}

/** Demo data so the dApp has something in every state the moment it opens. */
async function seed(manager) {
  const signers = await ethers.getSigners();
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const proposals = ["Solar Panels", "Water Refill Stations", "Bicycle Repair Hub"];
  let id = 0;

  const create = async (cfg) => {
    await (
      await manager.createElection({
        startTime: 0,
        revealDuration: 0,
        voterRoot: ethers.ZeroHash,
        ...cfg,
      })
    ).wait();
    return id++;
  };

  // 1. The original coursework scenario: open, public ballot with live tallies.
  const fund = await create({
    title: "Campus Sustainability Fund 2026",
    proposalNames: proposals,
    endTime: now + 7 * DAY,
  });
  for (const [i, choice] of [0, 0, 1, 1, 2].entries()) {
    await (await manager.connect(signers[i + 1]).vote(fund, choice, [])).wait();
  }

  // 2. Secret ballot restricted to an allowlist of the first 10 local accounts.
  const allowlist = buildAllowlist(signers.slice(0, 10).map((s) => s.address));
  saveAllowlist(allowlist);
  const council = await create({
    title: "Student Council President",
    proposalNames: ["Avery Chen", "Jordan Okafor", "Sam Rivera", "Priya Natarajan"],
    endTime: now + 2 * DAY,
    revealDuration: DAY,
    voterRoot: allowlist.root,
  });
  for (const i of [1, 2]) {
    const salt = ethers.id(`demo-salt-${i}`);
    const c = await manager.computeCommitment(council, i % 4, salt, signers[i].address);
    await (await manager.connect(signers[i]).commitVote(council, c, allowlist.voters[signers[i].address])).wait();
  }

  // 3. Scheduled election that has not opened yet.
  await create({
    title: "Library Opening Hours",
    proposalNames: ["Keep current hours", "Open until midnight", "Open 24/7 during exams"],
    startTime: now + DAY,
    endTime: now + 8 * DAY,
  });

  // 4. Finished election with a clear winner.
  const ended = await create({
    title: "Orientation Week Theme",
    proposalNames: ["Space Odyssey", "Retro Arcade", "Around the World"],
    endTime: now + DAY,
  });
  for (const [i, choice] of [1, 1, 1, 0, 2].entries()) {
    await (await manager.connect(signers[i + 1]).vote(ended, choice, [])).wait();
  }
  await (await manager.closeElection(ended)).wait();

  console.log(`Seeded ${id} demo elections (open, secret+allowlist, scheduled, ended).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

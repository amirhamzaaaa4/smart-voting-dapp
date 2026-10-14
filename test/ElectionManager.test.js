const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const {
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
} = require("./helpers");

describe("ElectionManager", function () {
  async function deployFixture() {
    const [admin, alice, bob, carol, dave, eve, relayer, outsider] = await ethers.getSigners();
    const manager = await ethers.deployContract("ElectionManager", [admin.address]);
    const roles = {
      DEFAULT_ADMIN: await manager.DEFAULT_ADMIN_ROLE(),
      ELECTION_ADMIN: await manager.ELECTION_ADMIN_ROLE(),
      PAUSER: await manager.PAUSER_ROLE(),
    };
    return { manager, roles, admin, alice, bob, carol, dave, eve, relayer, outsider };
  }

  async function openElectionFixture() {
    const base = await deployFixture();
    const id = await createElection(base.manager);
    return { ...base, id };
  }

  async function secretElectionFixture() {
    const base = await deployFixture();
    const id = await createElection(base.manager, { revealDuration: DAY });
    return { ...base, id };
  }

  // -------------------------------------------------------------------------
  describe("Deployment & roles", function () {
    it("grants every role to the admin", async function () {
      const { manager, roles, admin } = await loadFixture(deployFixture);
      for (const role of Object.values(roles)) {
        expect(await manager.hasRole(role, admin.address)).to.equal(true);
      }
    });

    it("starts with no elections and unpaused", async function () {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.electionCount()).to.equal(0n);
      expect(await manager.paused()).to.equal(false);
    });

    it("lets the default admin delegate the election-admin role", async function () {
      const { manager, roles, alice } = await loadFixture(deployFixture);
      await manager.grantRole(roles.ELECTION_ADMIN, alice.address);
      await expect(createElection(manager, {}, alice)).to.not.be.reverted;
    });

    it("stops a revoked election admin from creating elections", async function () {
      const { manager, roles, admin, alice } = await loadFixture(deployFixture);
      await manager.grantRole(roles.ELECTION_ADMIN, alice.address);
      await manager.revokeRole(roles.ELECTION_ADMIN, alice.address);
      await expect(createElection(manager, {}, alice))
        .to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount")
        .withArgs(alice.address, roles.ELECTION_ADMIN);
      expect(await manager.hasRole(roles.ELECTION_ADMIN, admin.address)).to.equal(true);
    });

    it("exposes the EIP-712 domain separator", async function () {
      const { manager } = await loadFixture(deployFixture);
      const { chainId } = await ethers.provider.getNetwork();
      const expected = ethers.TypedDataEncoder.hashDomain({
        name: "SmartVoting ElectionManager",
        version: "1",
        chainId,
        verifyingContract: await manager.getAddress(),
      });
      expect(await manager.DOMAIN_SEPARATOR()).to.equal(expected);
    });
  });

  // -------------------------------------------------------------------------
  describe("createElection", function () {
    it("stores the configuration and emits ElectionCreated", async function () {
      const { manager, admin } = await loadFixture(deployFixture);
      const cfg = await config();
      await expect(manager.createElection(cfg))
        .to.emit(manager, "ElectionCreated")
        .withArgs(0n, admin.address, cfg.title, anyValue, cfg.endTime, 0n, ethers.ZeroHash, 3n);

      const e = await manager.getElection(0);
      expect(e.title).to.equal(cfg.title);
      expect(e.creator).to.equal(admin.address);
      expect(e.proposalNames).to.deep.equal(PROPOSALS);
      expect(e.voteCounts).to.deep.equal([0n, 0n, 0n]);
      expect(e.status).to.equal(Status.Active);
      expect(e.secret).to.equal(false);
      expect(e.revealEndTime).to.equal(e.endTime);
    });

    it("treats a zero or past start time as 'now'", async function () {
      const { manager } = await loadFixture(deployFixture);
      await createElection(manager, { startTime: 1 });
      const e = await manager.getElection(0);
      expect(e.startTime).to.equal(BigInt(await time.latest()));
    });

    it("schedules a future election as Pending, then Active", async function () {
      const { manager } = await loadFixture(deployFixture);
      const now = await time.latest();
      await createElection(manager, { startTime: now + HOUR, endTime: now + 2 * HOUR });
      expect(await manager.status(0)).to.equal(Status.Pending);
      await time.increaseTo(now + HOUR);
      expect(await manager.status(0)).to.equal(Status.Active);
    });

    it("assigns sequential IDs", async function () {
      const { manager } = await loadFixture(deployFixture);
      await createElection(manager);
      await createElection(manager);
      expect(await manager.electionCount()).to.equal(2n);
      expect((await manager.getElection(1)).id).to.equal(1n);
    });

    it("rejects callers without ELECTION_ADMIN_ROLE", async function () {
      const { manager, roles, outsider } = await loadFixture(deployFixture);
      await expect(createElection(manager, {}, outsider))
        .to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, roles.ELECTION_ADMIN);
    });

    it("rejects empty and over-long titles", async function () {
      const { manager } = await loadFixture(deployFixture);
      await expect(createElection(manager, { title: "" })).to.be.revertedWithCustomError(manager, "InvalidTitle");
      await expect(createElection(manager, { title: "x".repeat(129) })).to.be.revertedWithCustomError(
        manager,
        "InvalidTitle",
      );
      await expect(createElection(manager, { title: "x".repeat(128) })).to.not.be.reverted;
    });

    it("enforces MIN_PROPOSALS and MAX_PROPOSALS", async function () {
      const { manager } = await loadFixture(deployFixture);
      await expect(createElection(manager, { proposalNames: ["Only one"] }))
        .to.be.revertedWithCustomError(manager, "InvalidProposalCount")
        .withArgs(1n);
      const tooMany = Array.from({ length: 21 }, (_, i) => `P${i}`);
      await expect(createElection(manager, { proposalNames: tooMany }))
        .to.be.revertedWithCustomError(manager, "InvalidProposalCount")
        .withArgs(21n);
      await expect(createElection(manager, { proposalNames: tooMany.slice(0, 20) })).to.not.be.reverted;
    });

    it("rejects empty proposal names", async function () {
      const { manager } = await loadFixture(deployFixture);
      await expect(createElection(manager, { proposalNames: ["A", ""] }))
        .to.be.revertedWithCustomError(manager, "EmptyProposalName")
        .withArgs(1n);
    });

    it("rejects invalid schedules", async function () {
      const { manager } = await loadFixture(deployFixture);
      const now = await time.latest();
      // end not after start
      await expect(
        createElection(manager, { startTime: now + HOUR, endTime: now + HOUR }),
      ).to.be.revertedWithCustomError(manager, "InvalidSchedule");
      // end in the past
      await expect(createElection(manager, { endTime: now - 1 })).to.be.revertedWithCustomError(
        manager,
        "InvalidSchedule",
      );
      // longer than MAX_DURATION
      await expect(
        createElection(manager, { startTime: now + 10, endTime: now + 10 + 365 * DAY + 1 }),
      ).to.be.revertedWithCustomError(manager, "InvalidSchedule");
    });

    it("rejects a reveal window longer than MAX_REVEAL_DURATION", async function () {
      const { manager } = await loadFixture(deployFixture);
      await expect(createElection(manager, { revealDuration: 30 * DAY + 1 }))
        .to.be.revertedWithCustomError(manager, "InvalidRevealDuration")
        .withArgs(30 * DAY + 1);
    });

    it("is blocked while paused", async function () {
      const { manager } = await loadFixture(deployFixture);
      await manager.pause();
      await expect(createElection(manager)).to.be.revertedWithCustomError(manager, "EnforcedPause");
    });
  });

  // -------------------------------------------------------------------------
  describe("Open ballot: vote", function () {
    it("counts a valid vote and emits VoteCast", async function () {
      const { manager, id, alice } = await loadFixture(openElectionFixture);
      await expect(manager.connect(alice).vote(id, 0, []))
        .to.emit(manager, "VoteCast")
        .withArgs(id, alice.address, 0n);
      expect(await manager.getResults(id)).to.deep.equal([1n, 0n, 0n]);
      expect(await manager.hasVoted(id, alice.address)).to.equal(true);
      expect((await manager.getElection(id)).totalVotes).to.equal(1n);
    });

    it("rejects a second vote from the same address", async function () {
      const { manager, id, alice } = await loadFixture(openElectionFixture);
      await manager.connect(alice).vote(id, 0, []);
      await expect(manager.connect(alice).vote(id, 1, []))
        .to.be.revertedWithCustomError(manager, "AlreadyVoted")
        .withArgs(id, alice.address);
    });

    it("rejects an out-of-range proposal", async function () {
      const { manager, id, alice } = await loadFixture(openElectionFixture);
      await expect(manager.connect(alice).vote(id, 3, []))
        .to.be.revertedWithCustomError(manager, "InvalidProposal")
        .withArgs(id, 3n);
    });

    it("rejects an unknown election", async function () {
      const { manager, alice } = await loadFixture(openElectionFixture);
      await expect(manager.connect(alice).vote(99, 0, []))
        .to.be.revertedWithCustomError(manager, "ElectionNotFound")
        .withArgs(99n);
    });

    it("rejects votes before the start time", async function () {
      const { manager, alice } = await loadFixture(deployFixture);
      const now = await time.latest();
      await createElection(manager, { startTime: now + HOUR, endTime: now + 2 * HOUR });
      await expect(manager.connect(alice).vote(0, 0, []))
        .to.be.revertedWithCustomError(manager, "WrongStatus")
        .withArgs(0n, Status.Pending);
    });

    it("rejects votes after the deadline", async function () {
      const { manager, id, alice } = await loadFixture(openElectionFixture);
      await time.increase(HOUR);
      await expect(manager.connect(alice).vote(id, 0, []))
        .to.be.revertedWithCustomError(manager, "WrongStatus")
        .withArgs(id, Status.Ended);
    });

    it("rejects commitVote on an open ballot", async function () {
      const { manager, id, alice } = await loadFixture(openElectionFixture);
      await expect(manager.connect(alice).commitVote(id, ethers.id("x"), []))
        .to.be.revertedWithCustomError(manager, "WrongBallotType")
        .withArgs(id);
    });

    it("keeps elections isolated from each other", async function () {
      const { manager, id, alice } = await loadFixture(openElectionFixture);
      const second = await createElection(manager);
      await manager.connect(alice).vote(id, 0, []);
      await manager.connect(alice).vote(second, 2, []);
      expect(await manager.getResults(id)).to.deep.equal([1n, 0n, 0n]);
      expect(await manager.getResults(second)).to.deep.equal([0n, 0n, 1n]);
    });
  });

  // -------------------------------------------------------------------------
  describe("Voter allowlists (Merkle)", function () {
    async function allowlistFixture() {
      const base = await deployFixture();
      const list = buildAllowlist([base.alice.address, base.bob.address, base.carol.address]);
      const id = await createElection(base.manager, { voterRoot: list.root });
      return { ...base, list, id };
    }

    it("accepts a listed voter with a valid proof", async function () {
      const { manager, id, alice, list } = await loadFixture(allowlistFixture);
      const proof = list.proofFor(alice.address);
      expect(await manager.isEligible(id, alice.address, proof)).to.equal(true);
      await expect(manager.connect(alice).vote(id, 1, proof)).to.emit(manager, "VoteCast");
    });

    it("rejects an unlisted voter", async function () {
      const { manager, id, outsider, list } = await loadFixture(allowlistFixture);
      expect(await manager.isEligible(id, outsider.address, [])).to.equal(false);
      await expect(manager.connect(outsider).vote(id, 0, list.proofFor(outsider.address)))
        .to.be.revertedWithCustomError(manager, "NotEligible")
        .withArgs(id, outsider.address);
    });

    it("rejects a proof borrowed from another voter", async function () {
      const { manager, id, outsider, alice, list } = await loadFixture(allowlistFixture);
      await expect(manager.connect(outsider).vote(id, 0, list.proofFor(alice.address))).to.be.revertedWithCustomError(
        manager,
        "NotEligible",
      );
    });

    it("treats a zero root as a public election", async function () {
      const { manager, outsider } = await loadFixture(openElectionFixture);
      expect(await manager.isEligible(0, outsider.address, [])).to.equal(true);
    });
  });

  // -------------------------------------------------------------------------
  describe("Gasless voting (EIP-712 voteBySig)", function () {
    it("lets a relayer submit a vote that is credited to the signer", async function () {
      const { manager, id, alice, relayer } = await loadFixture(openElectionFixture);
      const deadline = (await time.latest()) + HOUR;
      const sig = await signVote(manager, alice, { electionId: id, proposalIndex: 2, deadline });

      await expect(manager.connect(relayer).voteBySig(id, 2, alice.address, deadline, [], sig))
        .to.emit(manager, "VoteCast")
        .withArgs(id, alice.address, 2n);
      expect(await manager.hasVoted(id, alice.address)).to.equal(true);
      expect(await manager.hasVoted(id, relayer.address)).to.equal(false);
      expect(await manager.nonces(alice.address)).to.equal(1n);
    });

    it("cannot be replayed", async function () {
      const { manager, id, alice, relayer } = await loadFixture(openElectionFixture);
      const deadline = (await time.latest()) + HOUR;
      const sig = await signVote(manager, alice, { electionId: id, proposalIndex: 0, deadline });
      await manager.connect(relayer).voteBySig(id, 0, alice.address, deadline, [], sig);
      // Nonce has moved on, so the same signature no longer matches.
      await expect(
        manager.connect(relayer).voteBySig(id, 0, alice.address, deadline, [], sig),
      ).to.be.revertedWithCustomError(manager, "InvalidSignature");
    });

    it("rejects tampered parameters", async function () {
      const { manager, id, alice, relayer } = await loadFixture(openElectionFixture);
      const deadline = (await time.latest()) + HOUR;
      const sig = await signVote(manager, alice, { electionId: id, proposalIndex: 0, deadline });
      await expect(
        manager.connect(relayer).voteBySig(id, 1, alice.address, deadline, [], sig),
      ).to.be.revertedWithCustomError(manager, "InvalidSignature");
    });

    it("rejects a signature from someone other than the voter", async function () {
      const { manager, id, alice, bob, relayer } = await loadFixture(openElectionFixture);
      const deadline = (await time.latest()) + HOUR;
      const sig = await signVote(manager, bob, {
        electionId: id,
        proposalIndex: 0,
        voter: alice.address,
        deadline,
      });
      await expect(
        manager.connect(relayer).voteBySig(id, 0, alice.address, deadline, [], sig),
      ).to.be.revertedWithCustomError(manager, "InvalidSignature");
    });

    it("rejects expired signatures", async function () {
      const { manager, id, alice, relayer } = await loadFixture(openElectionFixture);
      const deadline = (await time.latest()) + 60;
      const sig = await signVote(manager, alice, { electionId: id, proposalIndex: 0, deadline });
      await time.increase(61);
      await expect(manager.connect(relayer).voteBySig(id, 0, alice.address, deadline, [], sig))
        .to.be.revertedWithCustomError(manager, "SignatureExpired")
        .withArgs(deadline);
    });

    it("supports smart-contract wallets via ERC-1271", async function () {
      const { manager, id, alice, relayer } = await loadFixture(openElectionFixture);
      const wallet = await ethers.deployContract("MockERC1271Wallet", [alice.address]);
      const walletAddr = await wallet.getAddress();
      const deadline = (await time.latest()) + HOUR;
      const sig = await signVote(manager, alice, {
        electionId: id,
        proposalIndex: 1,
        voter: walletAddr,
        deadline,
      });
      await expect(manager.connect(relayer).voteBySig(id, 1, walletAddr, deadline, [], sig))
        .to.emit(manager, "VoteCast")
        .withArgs(id, walletAddr, 1n);
    });

    it("still enforces one vote per address", async function () {
      const { manager, id, alice, relayer } = await loadFixture(openElectionFixture);
      await manager.connect(alice).vote(id, 0, []);
      const deadline = (await time.latest()) + HOUR;
      const sig = await signVote(manager, alice, { electionId: id, proposalIndex: 1, deadline });
      await expect(manager.connect(relayer).voteBySig(id, 1, alice.address, deadline, [], sig))
        .to.be.revertedWithCustomError(manager, "AlreadyVoted")
        .withArgs(id, alice.address);
    });
  });

  // -------------------------------------------------------------------------
  describe("Secret ballot (commit-reveal)", function () {
    const SALT_A = ethers.id("alice-salt");
    const SALT_B = ethers.id("bob-salt");

    it("matches the on-chain commitment encoding", async function () {
      const { manager, alice } = await loadFixture(deployFixture);
      expect(await manager.computeCommitment(7, 2, SALT_A, alice.address)).to.equal(
        commitment(7, 2, SALT_A, alice.address),
      );
    });

    it("hides choices during voting and counts them on reveal", async function () {
      const { manager, id, alice, bob } = await loadFixture(secretElectionFixture);
      const c = commitment(id, 1, SALT_A, alice.address);

      await expect(manager.connect(alice).commitVote(id, c, []))
        .to.emit(manager, "VoteCommitted")
        .withArgs(id, alice.address, c);
      await manager.connect(bob).commitVote(id, commitment(id, 1, SALT_B, bob.address), []);

      let e = await manager.getElection(id);
      expect(e.secret).to.equal(true);
      expect(e.totalCommits).to.equal(2n);
      expect(e.voteCounts).to.deep.equal([0n, 0n, 0n]); // nothing visible yet

      await time.increaseTo(e.endTime);
      expect(await manager.status(id)).to.equal(Status.Revealing);

      await expect(manager.connect(alice).revealVote(id, 1, SALT_A))
        .to.emit(manager, "VoteRevealed")
        .withArgs(id, alice.address, 1n);
      await manager.connect(bob).revealVote(id, 1, SALT_B);

      e = await manager.getElection(id);
      expect(e.voteCounts).to.deep.equal([0n, 2n, 0n]);
      expect(e.totalVotes).to.equal(2n);

      await time.increaseTo(e.revealEndTime);
      expect(await manager.status(id)).to.equal(Status.Ended);
      expect(await manager.getWinner(id)).to.equal(PROPOSALS[1]);
    });

    it("rejects direct votes on a secret ballot", async function () {
      const { manager, id, alice } = await loadFixture(secretElectionFixture);
      await expect(manager.connect(alice).vote(id, 0, []))
        .to.be.revertedWithCustomError(manager, "WrongBallotType")
        .withArgs(id);
    });

    it("rejects empty and duplicate commitments", async function () {
      const { manager, id, alice } = await loadFixture(secretElectionFixture);
      await expect(manager.connect(alice).commitVote(id, ethers.ZeroHash, [])).to.be.revertedWithCustomError(
        manager,
        "EmptyCommitment",
      );
      await manager.connect(alice).commitVote(id, commitment(id, 0, SALT_A, alice.address), []);
      await expect(manager.connect(alice).commitVote(id, commitment(id, 1, SALT_A, alice.address), []))
        .to.be.revertedWithCustomError(manager, "AlreadyVoted")
        .withArgs(id, alice.address);
    });

    it("enforces the allowlist on commit", async function () {
      const { manager, alice, outsider } = await loadFixture(deployFixture);
      const list = buildAllowlist([alice.address]);
      const id = await createElection(manager, { revealDuration: DAY, voterRoot: list.root });
      await expect(
        manager.connect(outsider).commitVote(id, commitment(id, 0, SALT_A, outsider.address), []),
      ).to.be.revertedWithCustomError(manager, "NotEligible");
      await expect(
        manager.connect(alice).commitVote(id, commitment(id, 0, SALT_A, alice.address), list.proofFor(alice.address)),
      ).to.emit(manager, "VoteCommitted");
    });

    it("rejects reveals outside the reveal window", async function () {
      const { manager, id, alice } = await loadFixture(secretElectionFixture);
      await manager.connect(alice).commitVote(id, commitment(id, 0, SALT_A, alice.address), []);
      await expect(manager.connect(alice).revealVote(id, 0, SALT_A))
        .to.be.revertedWithCustomError(manager, "WrongStatus")
        .withArgs(id, Status.Active);
      const e = await manager.getElection(id);
      await time.increaseTo(e.revealEndTime);
      await expect(manager.connect(alice).revealVote(id, 0, SALT_A))
        .to.be.revertedWithCustomError(manager, "WrongStatus")
        .withArgs(id, Status.Ended);
    });

    it("rejects reveals that do not match the commitment", async function () {
      const { manager, id, alice, bob } = await loadFixture(secretElectionFixture);
      await manager.connect(alice).commitVote(id, commitment(id, 0, SALT_A, alice.address), []);
      await time.increaseTo((await manager.getElection(id)).endTime);

      // wrong choice, wrong salt
      await expect(manager.connect(alice).revealVote(id, 1, SALT_A)).to.be.revertedWithCustomError(
        manager,
        "CommitmentMismatch",
      );
      await expect(manager.connect(alice).revealVote(id, 0, SALT_B)).to.be.revertedWithCustomError(
        manager,
        "CommitmentMismatch",
      );
      // someone who never committed
      await expect(manager.connect(bob).revealVote(id, 0, SALT_A))
        .to.be.revertedWithCustomError(manager, "NoCommitment")
        .withArgs(id, bob.address);
    });

    it("prevents copying another voter's commitment", async function () {
      const { manager, id, alice, bob } = await loadFixture(secretElectionFixture);
      const c = commitment(id, 0, SALT_A, alice.address);
      await manager.connect(alice).commitVote(id, c, []);
      await manager.connect(bob).commitVote(id, c, []); // copied hash
      await time.increaseTo((await manager.getElection(id)).endTime);
      // Bob learns Alice's salt but still cannot reveal: the commitment is bound to Alice.
      await expect(manager.connect(bob).revealVote(id, 0, SALT_A)).to.be.revertedWithCustomError(
        manager,
        "CommitmentMismatch",
      );
    });

    it("rejects double reveals", async function () {
      const { manager, id, alice } = await loadFixture(secretElectionFixture);
      await manager.connect(alice).commitVote(id, commitment(id, 0, SALT_A, alice.address), []);
      await time.increaseTo((await manager.getElection(id)).endTime);
      await manager.connect(alice).revealVote(id, 0, SALT_A);
      await expect(manager.connect(alice).revealVote(id, 0, SALT_A))
        .to.be.revertedWithCustomError(manager, "AlreadyRevealed")
        .withArgs(id, alice.address);
    });

    it("treats a commitment to an invalid proposal as a spoiled ballot", async function () {
      const { manager, id, alice } = await loadFixture(secretElectionFixture);
      await manager.connect(alice).commitVote(id, commitment(id, 9, SALT_A, alice.address), []);
      await time.increaseTo((await manager.getElection(id)).endTime);
      await expect(manager.connect(alice).revealVote(id, 9, SALT_A))
        .to.be.revertedWithCustomError(manager, "InvalidProposal")
        .withArgs(id, 9n);
    });

    it("ignores unrevealed commitments in the outcome", async function () {
      const { manager, id, alice, bob } = await loadFixture(secretElectionFixture);
      await manager.connect(alice).commitVote(id, commitment(id, 0, SALT_A, alice.address), []);
      await manager.connect(bob).commitVote(id, commitment(id, 1, SALT_B, bob.address), []);
      await time.increaseTo((await manager.getElection(id)).endTime);
      await manager.connect(alice).revealVote(id, 0, SALT_A); // Bob never reveals
      await time.increaseTo((await manager.getElection(id)).revealEndTime);
      expect(await manager.getWinner(id)).to.equal(PROPOSALS[0]);
    });

    it("early close moves an active secret ballot into its reveal window", async function () {
      const { manager, id, alice } = await loadFixture(secretElectionFixture);
      await manager.connect(alice).commitVote(id, commitment(id, 2, SALT_A, alice.address), []);
      await manager.closeElection(id);
      const e = await manager.getElection(id);
      expect(e.status).to.equal(Status.Revealing);
      expect(e.closedEarly).to.equal(true);
      expect(e.revealEndTime - e.endTime).to.equal(BigInt(DAY));
      await manager.connect(alice).revealVote(id, 2, SALT_A);
      await expect(manager.closeElection(id))
        .to.be.revertedWithCustomError(manager, "WrongStatus")
        .withArgs(id, Status.Revealing);
    });
  });

  // -------------------------------------------------------------------------
  describe("closeElection", function () {
    it("lets an election admin end an active election early", async function () {
      const { manager, id, admin, alice } = await loadFixture(openElectionFixture);
      await expect(manager.closeElection(id)).to.emit(manager, "ElectionClosed").withArgs(id, admin.address, false);
      const e = await manager.getElection(id);
      expect(e.status).to.equal(Status.Ended);
      expect(e.closedEarly).to.equal(true);
      expect(e.cancelled).to.equal(false);
      await expect(manager.connect(alice).vote(id, 0, [])).to.be.revertedWithCustomError(manager, "WrongStatus");
    });

    it("cancels a pending election", async function () {
      const { manager, admin } = await loadFixture(deployFixture);
      const now = await time.latest();
      const id = await createElection(manager, { startTime: now + HOUR, endTime: now + 2 * HOUR });
      await expect(manager.closeElection(id)).to.emit(manager, "ElectionClosed").withArgs(id, admin.address, true);
      expect((await manager.getElection(id)).cancelled).to.equal(true);
      // Stays ended even once the original start time arrives.
      await time.increaseTo(now + HOUR);
      expect(await manager.status(id)).to.equal(Status.Ended);
      expect(await manager.getWinner(id)).to.equal("No votes cast");
    });

    it("rejects non-admins", async function () {
      const { manager, id, roles, outsider } = await loadFixture(openElectionFixture);
      await expect(manager.connect(outsider).closeElection(id))
        .to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, roles.ELECTION_ADMIN);
    });

    it("rejects closing an ended election", async function () {
      const { manager, id } = await loadFixture(openElectionFixture);
      await manager.closeElection(id);
      await expect(manager.closeElection(id))
        .to.be.revertedWithCustomError(manager, "WrongStatus")
        .withArgs(id, Status.Ended);
    });

    it("rejects unknown elections", async function () {
      const { manager } = await loadFixture(deployFixture);
      await expect(manager.closeElection(0)).to.be.revertedWithCustomError(manager, "ElectionNotFound");
    });
  });

  // -------------------------------------------------------------------------
  describe("Pause", function () {
    it("blocks voting, commits, reveals and gasless votes while paused", async function () {
      const { manager, alice, relayer } = await loadFixture(deployFixture);
      const open = await createElection(manager);
      const secret = await createElection(manager, { revealDuration: DAY });
      const salt = ethers.id("s");
      await manager.connect(alice).commitVote(secret, commitment(secret, 0, salt, alice.address), []);

      const deadline = (await time.latest()) + 2 * HOUR;
      const sig = await signVote(manager, alice, { electionId: open, proposalIndex: 0, deadline });

      await manager.pause();
      await expect(manager.connect(alice).vote(open, 0, [])).to.be.revertedWithCustomError(manager, "EnforcedPause");
      await expect(
        manager.connect(relayer).voteBySig(open, 0, alice.address, deadline, [], sig),
      ).to.be.revertedWithCustomError(manager, "EnforcedPause");
      await expect(manager.connect(alice).commitVote(secret, ethers.id("c"), [])).to.be.revertedWithCustomError(
        manager,
        "EnforcedPause",
      );

      await time.increaseTo((await manager.getElection(secret)).endTime);
      await expect(manager.connect(alice).revealVote(secret, 0, salt)).to.be.revertedWithCustomError(
        manager,
        "EnforcedPause",
      );

      await manager.unpause();
      await expect(manager.connect(alice).revealVote(secret, 0, salt)).to.emit(manager, "VoteRevealed");
    });

    it("is restricted to PAUSER_ROLE", async function () {
      const { manager, roles, outsider } = await loadFixture(deployFixture);
      await expect(manager.connect(outsider).pause())
        .to.be.revertedWithCustomError(manager, "AccessControlUnauthorizedAccount")
        .withArgs(outsider.address, roles.PAUSER);
      await manager.pause();
      await expect(manager.connect(outsider).unpause()).to.be.revertedWithCustomError(
        manager,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("Outcome", function () {
    async function runOpen(manager, signers, choices) {
      const id = await createElection(manager);
      for (let i = 0; i < choices.length; i++) {
        await manager.connect(signers[i]).vote(id, choices[i], []);
      }
      await manager.closeElection(id);
      return id;
    }

    it("reverts while the election is not ended", async function () {
      const { manager, id } = await loadFixture(openElectionFixture);
      await expect(manager.getOutcome(id)).to.be.revertedWithCustomError(manager, "ElectionNotEnded").withArgs(id);
      await expect(manager.getWinner(id)).to.be.revertedWithCustomError(manager, "ElectionNotEnded");
    });

    it("reports NoVotes", async function () {
      const { manager } = await loadFixture(deployFixture);
      const id = await runOpen(manager, [], []);
      expect(await manager.getOutcome(id)).to.deep.equal([Outcome.NoVotes, 0n, 0n]);
      expect(await manager.getWinner(id)).to.equal("No votes cast");
    });

    it("reports a clear winner (1, 0, 0)", async function () {
      const { manager, alice } = await loadFixture(deployFixture);
      const id = await runOpen(manager, [alice], [0]);
      expect(await manager.getOutcome(id)).to.deep.equal([Outcome.Winner, 0n, 1n]);
      expect(await manager.getWinner(id)).to.equal("Solar Panels");
    });

    it("reports a winner in the last position", async function () {
      const { manager, alice, bob, carol } = await loadFixture(deployFixture);
      const id = await runOpen(manager, [alice, bob, carol], [0, 2, 2]);
      expect(await manager.getOutcome(id)).to.deep.equal([Outcome.Winner, 2n, 2n]);
      expect(await manager.getWinner(id)).to.equal("Bicycle Repair Hub");
    });

    it("reports a two-way tie for first (2, 2, 1)", async function () {
      const { manager, alice, bob, carol, dave, eve } = await loadFixture(deployFixture);
      const id = await runOpen(manager, [alice, bob, carol, dave, eve], [0, 0, 1, 1, 2]);
      expect(await manager.getOutcome(id)).to.deep.equal([Outcome.Tie, 0n, 2n]);
      expect(await manager.getWinner(id)).to.equal("Tie");
    });

    it("reports a three-way tie (1, 1, 1)", async function () {
      const { manager, alice, bob, carol } = await loadFixture(deployFixture);
      const id = await runOpen(manager, [alice, bob, carol], [0, 1, 2]);
      expect(await manager.getOutcome(id)).to.deep.equal([Outcome.Tie, 0n, 1n]);
    });

    it("does not report a tie for second place (2, 1, 1)", async function () {
      const { manager, alice, bob, carol, dave } = await loadFixture(deployFixture);
      const id = await runOpen(manager, [alice, bob, carol, dave], [0, 0, 1, 2]);
      expect(await manager.getOutcome(id)).to.deep.equal([Outcome.Winner, 0n, 2n]);
    });

    it("reports a tie between non-adjacent proposals (1, 0, 1)", async function () {
      const { manager, alice, bob } = await loadFixture(deployFixture);
      const id = await runOpen(manager, [alice, bob], [0, 2]);
      expect(await manager.getOutcome(id)).to.deep.equal([Outcome.Tie, 0n, 1n]);
    });

    it("is available after the natural deadline without an early close", async function () {
      const { manager, id, alice } = await loadFixture(openElectionFixture);
      await manager.connect(alice).vote(id, 1, []);
      await time.increase(HOUR);
      expect(await manager.getWinner(id)).to.equal("Water Refill Stations");
    });
  });

  // -------------------------------------------------------------------------
  describe("Views", function () {
    it("paginates elections", async function () {
      const { manager } = await loadFixture(deployFixture);
      for (let i = 0; i < 5; i++) await createElection(manager, { title: `Election ${i}` });

      const page = await manager.getElections(1, 2);
      expect(page.map((e) => e.title)).to.deep.equal(["Election 1", "Election 2"]);
      expect((await manager.getElections(3, 10)).length).to.equal(2);
      expect((await manager.getElections(0, ethers.MaxUint256)).length).to.equal(5);
      expect((await manager.getElections(5, 1)).length).to.equal(0);
    });

    it("reverts reads on unknown elections", async function () {
      const { manager, alice } = await loadFixture(deployFixture);
      await expect(manager.getElection(0)).to.be.revertedWithCustomError(manager, "ElectionNotFound");
      await expect(manager.getResults(0)).to.be.revertedWithCustomError(manager, "ElectionNotFound");
      await expect(manager.status(0)).to.be.revertedWithCustomError(manager, "ElectionNotFound");
      await expect(manager.isEligible(0, alice.address, [])).to.be.revertedWithCustomError(manager, "ElectionNotFound");
    });

    it("supports the AccessControl interface (ERC-165)", async function () {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.supportsInterface("0x7965db0b")).to.equal(true); // IAccessControl
    });
  });
});

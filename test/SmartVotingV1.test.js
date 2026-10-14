// Automated versions of the 10 manual Remix tests from the original coursework
// report, run against the unmodified v1 contract (contracts/legacy/SmartVotingV1.sol).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SmartVotingV1 (coursework baseline)", function () {
  async function deployFixture() {
    const accounts = await ethers.getSigners(); // accounts[0] = "Account 1" in the report
    const ballot = await ethers.deployContract("SmartVotingV1", [3600]);
    return { ballot, accounts };
  }

  async function fiveVotersFixture() {
    const { ballot, accounts } = await deployFixture();
    const choices = [1, 1, 2, 2, 3];
    for (let i = 0; i < choices.length; i++) {
      await ballot.connect(accounts[i]).vote(choices[i]);
    }
    return { ballot, accounts };
  }

  it("Test 1: deploys and sets the deployer as owner", async function () {
    const { ballot, accounts } = await loadFixture(deployFixture);
    expect(await ballot.owner()).to.equal(accounts[0].address);
    expect(await ballot.votingOpen()).to.equal(true);
  });

  it("Test 1b: rejects a zero duration", async function () {
    await expect(ethers.deployContract("SmartVotingV1", [0])).to.be.revertedWith("Duration must be greater than zero");
  });

  it("Test 2: accepts a first valid vote -> (1, 0, 0)", async function () {
    const { ballot, accounts } = await loadFixture(deployFixture);
    await expect(ballot.connect(accounts[0]).vote(1)).to.emit(ballot, "VoteCast").withArgs(accounts[0].address, 1);
    expect(await ballot.getResults()).to.deep.equal([1n, 0n, 0n]);
  });

  it("Test 3: five different voters -> (2, 2, 1)", async function () {
    const { ballot } = await loadFixture(fiveVotersFixture);
    expect(await ballot.getResults()).to.deep.equal([2n, 2n, 1n]);
  });

  it("Test 4: rejects a repeat vote", async function () {
    const { ballot, accounts } = await loadFixture(fiveVotersFixture);
    await expect(ballot.connect(accounts[0]).vote(2)).to.be.revertedWith("Already voted");
  });

  it("Test 5: rejects an invalid candidate", async function () {
    const { ballot, accounts } = await loadFixture(deployFixture);
    await expect(ballot.connect(accounts[5]).vote(4)).to.be.revertedWith("Invalid candidate");
    await expect(ballot.connect(accounts[5]).vote(0)).to.be.revertedWith("Invalid candidate");
  });

  it("Test 6: rejects early close by a non-owner", async function () {
    const { ballot, accounts } = await loadFixture(fiveVotersFixture);
    await expect(ballot.connect(accounts[5]).closeVoting()).to.be.revertedWith("Only owner can close voting");
  });

  it("Test 7: lets the owner close early", async function () {
    const { ballot, accounts } = await loadFixture(fiveVotersFixture);
    await expect(ballot.connect(accounts[0]).closeVoting())
      .to.emit(ballot, "VotingClosed")
      .withArgs(accounts[0].address);
    expect(await ballot.closedEarly()).to.equal(true);
    await expect(ballot.closeVoting()).to.be.revertedWith("Voting is already closed");
  });

  it("Test 8: rejects a vote after early closure", async function () {
    const { ballot, accounts } = await loadFixture(fiveVotersFixture);
    await ballot.closeVoting();
    await expect(ballot.connect(accounts[5]).vote(1)).to.be.revertedWith("Voting is closed");
  });

  it("Test 9: rejects a vote after the deadline", async function () {
    const { accounts } = await loadFixture(deployFixture);
    const shortBallot = await ethers.deployContract("SmartVotingV1", [60], accounts[5]);
    await time.increase(61);
    await expect(shortBallot.vote(1)).to.be.revertedWith("Voting is closed");
    expect(await shortBallot.closedEarly()).to.equal(false);
    expect(await shortBallot.votingOpen()).to.equal(false);
  });

  describe("Test 10: final result and winner", function () {
    it("reverts getWinner while voting is open", async function () {
      const { ballot } = await loadFixture(fiveVotersFixture);
      await expect(ballot.getWinner()).to.be.revertedWith("Voting is still open");
    });

    it("(2, 2, 1) -> Tie", async function () {
      const { ballot } = await loadFixture(fiveVotersFixture);
      await ballot.closeVoting();
      expect(await ballot.getWinner()).to.equal("Tie");
    });

    it("(1, 0, 0) -> Candidate 1", async function () {
      const { ballot } = await loadFixture(deployFixture);
      await ballot.vote(1);
      await ballot.closeVoting();
      expect(await ballot.getWinner()).to.equal("Candidate 1");
    });

    for (const [choices, expected] of [
      [[], "No votes cast"],
      [[1, 2, 3], "Tie"],
      [[1, 3], "Tie"],
      [[2, 3], "Tie"],
      [[2], "Candidate 2"],
      [[3], "Candidate 3"],
    ]) {
      it(`(${choices.join(", ") || "no votes"}) -> ${expected}`, async function () {
        const { ballot, accounts } = await loadFixture(deployFixture);
        for (let i = 0; i < choices.length; i++) await ballot.connect(accounts[i]).vote(choices[i]);
        await ballot.closeVoting();
        expect(await ballot.getWinner()).to.equal(expected);
      });
    }
  });
});

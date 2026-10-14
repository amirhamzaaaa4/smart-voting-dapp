// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Original coursework submission (COIT12211, CQUniversity), kept unchanged
// apart from the contract name. Adapted from the Week 6 SimpleVote tutorial.
// See contracts/SmartVoting.sol for the refactored version.
contract SmartVotingV1 {
    address public owner;
    uint256 public votingEndTime;
    bool public closedEarly;

    mapping(address => bool) public hasVoted;

    // 1 = Solar Panels
    // 2 = Water Refill Stations
    // 3 = Bicycle Repair Hub
    uint256 public candidateA;
    uint256 public candidateB;
    uint256 public candidateC;

    event VoteCast(address indexed voter, uint256 candidate);
    event VotingClosed(address indexed closedBy);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can close voting");
        _;
    }

    constructor(uint256 durationSeconds) {
        require(
            durationSeconds > 0,
            "Duration must be greater than zero"
        );

        owner = msg.sender;
        votingEndTime = block.timestamp + durationSeconds;
    }

    // Voting must be within the deadline and not closed early.
    function votingOpen() public view returns (bool) {
        return !closedEarly && block.timestamp < votingEndTime;
    }

    function vote(uint256 candidate) public {
        require(votingOpen(), "Voting is closed");
        require(!hasVoted[msg.sender], "Already voted");
        require(
            candidate >= 1 && candidate <= 3,
            "Invalid candidate"
        );

        hasVoted[msg.sender] = true;

        if (candidate == 1) {
            candidateA += 1;
        } else if (candidate == 2) {
            candidateB += 1;
        } else {
            candidateC += 1;
        }

        emit VoteCast(msg.sender, candidate);
    }

    function closeVoting() public onlyOwner {
        require(votingOpen(), "Voting is already closed");

        closedEarly = true;

        emit VotingClosed(msg.sender);
    }

    function getResults()
        public
        view
        returns (uint256, uint256, uint256)
    {
        return (candidateA, candidateB, candidateC);
    }

    function getWinner() public view returns (string memory) {
        require(!votingOpen(), "Voting is still open");

        if (
            candidateA == 0 &&
            candidateB == 0 &&
            candidateC == 0
        ) {
            return "No votes cast";
        }

        // All three proposals share the highest total.
        if (
            candidateA == candidateB &&
            candidateB == candidateC
        ) {
            return "Tie";
        }

        // Two proposals share the highest total.
        if (
            candidateA == candidateB &&
            candidateA > candidateC
        ) {
            return "Tie";
        }

        if (
            candidateA == candidateC &&
            candidateA > candidateB
        ) {
            return "Tie";
        }

        if (
            candidateB == candidateC &&
            candidateB > candidateA
        ) {
            return "Tie";
        }

        if (
            candidateA > candidateB &&
            candidateA > candidateC
        ) {
            return "Candidate 1";
        }

        if (
            candidateB > candidateA &&
            candidateB > candidateC
        ) {
            return "Candidate 2";
        }

        return "Candidate 3";
    }
}
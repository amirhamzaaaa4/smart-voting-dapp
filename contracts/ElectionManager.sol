// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title ElectionManager
/// @author SmartVoting contributors
/// @notice Runs any number of independent, time-boxed elections from one contract.
///
///         Every election has its own proposals, schedule and (optionally) a
///         Merkle-root voter allowlist, and runs in one of two modes:
///
///         - **Open ballot**: votes are counted immediately and tallies are live.
///           Voters can vote directly or gaslessly by signing an EIP-712 message
///           that any relayer submits on their behalf.
///         - **Secret ballot** (commit-reveal): during voting, voters submit only a
///           hash of their choice. After the deadline a reveal window opens and
///           only revealed votes are counted, so no one can see or react to the
///           running tally while voting is open.
///
/// @dev Roles:
///      - DEFAULT_ADMIN_ROLE  grants / revokes the other roles (use a multisig).
///      - ELECTION_ADMIN_ROLE creates elections and may close them early.
///      - PAUSER_ROLE         emergency stop for voting and election creation.
///
///      Allowlist leaves follow the OpenZeppelin StandardMerkleTree format
///      `keccak256(bytes.concat(keccak256(abi.encode(voter))))`, so trees can be
///      built off-chain with the OpenZeppelin merkle-tree JS library (scripts/build-allowlist.js).
contract ElectionManager is AccessControl, Pausable, EIP712, Nonces {
    // ---------------------------------------------------------------------
    // Roles, limits, typehashes
    // ---------------------------------------------------------------------

    bytes32 public constant ELECTION_ADMIN_ROLE = keccak256("ELECTION_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 public constant VOTE_TYPEHASH = keccak256(
        "Vote(uint256 electionId,uint256 proposalIndex,address voter,uint256 nonce,uint256 deadline)"
    );

    uint256 public constant MIN_PROPOSALS = 2;
    /// @notice Bounds loops over proposals so every call has a predictable gas cost.
    uint256 public constant MAX_PROPOSALS = 20;
    uint256 public constant MAX_TITLE_LENGTH = 128;
    uint256 public constant MAX_DURATION = 365 days;
    uint256 public constant MAX_REVEAL_DURATION = 30 days;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Status {
        Pending, // start time not reached
        Active, // accepting votes (open ballot) or commitments (secret ballot)
        Revealing, // secret ballot only: accepting reveals
        Ended // final; outcome available
    }

    enum Outcome {
        NoVotes,
        Winner,
        Tie
    }

    /// @notice Parameters for `createElection`.
    /// @param startTime Unix start; 0 or a past value means "start now".
    /// @param endTime Unix voting deadline; after start and within MAX_DURATION of it.
    /// @param revealDuration 0 for an open ballot, otherwise the reveal window length in seconds.
    /// @param voterRoot Merkle root of eligible voters, or bytes32(0) for a public election.
    struct ElectionConfig {
        string title;
        string[] proposalNames;
        uint64 startTime;
        uint64 endTime;
        uint64 revealDuration;
        bytes32 voterRoot;
    }

    struct Election {
        string title;
        address creator;
        uint64 startTime;
        uint64 endTime; // moved forward to `now` when closed early
        uint64 revealDuration;
        bool closedEarly;
        bool cancelled; // closed before it started
        bytes32 voterRoot;
        uint256 totalCommits; // secret ballot only
        uint256 totalVotes; // counted votes (revealed votes for secret ballots)
        string[] proposalNames;
        uint256[] voteCounts;
    }

    /// @notice Flattened read model for off-chain clients.
    struct ElectionView {
        uint256 id;
        string title;
        address creator;
        uint64 startTime;
        uint64 endTime;
        uint64 revealEndTime;
        bool secret;
        bool closedEarly;
        bool cancelled;
        bytes32 voterRoot;
        uint256 totalCommits;
        uint256 totalVotes;
        Status status;
        string[] proposalNames;
        uint256[] voteCounts; // all zeros while a secret ballot is still being voted on
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    Election[] private _elections;

    /// @notice electionId => voter => has voted (open ballot) or committed (secret ballot).
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    /// @notice electionId => voter => vote commitment (secret ballot only).
    mapping(uint256 => mapping(address => bytes32)) public commitments;

    /// @notice electionId => voter => has revealed (secret ballot only).
    mapping(uint256 => mapping(address => bool)) public hasRevealed;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ElectionCreated(
        uint256 indexed electionId,
        address indexed creator,
        string title,
        uint64 startTime,
        uint64 endTime,
        uint64 revealDuration,
        bytes32 voterRoot,
        uint256 proposalCount
    );
    event VoteCast(uint256 indexed electionId, address indexed voter, uint256 indexed proposalIndex);
    event VoteCommitted(uint256 indexed electionId, address indexed voter, bytes32 commitment);
    event VoteRevealed(uint256 indexed electionId, address indexed voter, uint256 indexed proposalIndex);
    event ElectionClosed(uint256 indexed electionId, address indexed closedBy, bool cancelled);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error InvalidTitle();
    error InvalidProposalCount(uint256 count);
    error EmptyProposalName(uint256 index);
    error InvalidSchedule(uint64 startTime, uint64 endTime);
    error InvalidRevealDuration(uint64 revealDuration);
    error ElectionNotFound(uint256 electionId);
    error WrongStatus(uint256 electionId, Status status);
    error WrongBallotType(uint256 electionId);
    error ElectionNotEnded(uint256 electionId);
    error AlreadyVoted(uint256 electionId, address voter);
    error NotEligible(uint256 electionId, address voter);
    error InvalidProposal(uint256 electionId, uint256 proposalIndex);
    error EmptyCommitment();
    error NoCommitment(uint256 electionId, address voter);
    error AlreadyRevealed(uint256 electionId, address voter);
    error CommitmentMismatch(uint256 electionId, address voter);
    error SignatureExpired(uint256 deadline);
    error InvalidSignature();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param admin Receives every role. Use a multisig in production.
    constructor(address admin) EIP712("SmartVoting ElectionManager", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ELECTION_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    modifier electionExists(uint256 electionId) {
        if (electionId >= _elections.length) revert ElectionNotFound(electionId);
        _;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @notice Create a new election. See {ElectionConfig} for parameter rules.
    /// @return electionId The new election's ID (0-based, sequential).
    function createElection(
        ElectionConfig calldata config
    ) external onlyRole(ELECTION_ADMIN_ROLE) whenNotPaused returns (uint256 electionId) {
        uint256 titleLength = bytes(config.title).length;
        if (titleLength == 0 || titleLength > MAX_TITLE_LENGTH) revert InvalidTitle();

        uint256 count = config.proposalNames.length;
        if (count < MIN_PROPOSALS || count > MAX_PROPOSALS) revert InvalidProposalCount(count);

        uint64 start = config.startTime < block.timestamp ? uint64(block.timestamp) : config.startTime;
        if (config.endTime <= start || config.endTime - start > MAX_DURATION) {
            revert InvalidSchedule(start, config.endTime);
        }
        if (config.revealDuration > MAX_REVEAL_DURATION) revert InvalidRevealDuration(config.revealDuration);

        electionId = _elections.length;
        Election storage e = _elections.push();
        e.title = config.title;
        e.creator = msg.sender;
        e.startTime = start;
        e.endTime = config.endTime;
        e.revealDuration = config.revealDuration;
        e.voterRoot = config.voterRoot;
        e.voteCounts = new uint256[](count);

        for (uint256 i = 0; i < count; ++i) {
            if (bytes(config.proposalNames[i]).length == 0) revert EmptyProposalName(i);
            e.proposalNames.push(config.proposalNames[i]);
        }

        emit ElectionCreated(
            electionId,
            msg.sender,
            config.title,
            start,
            config.endTime,
            config.revealDuration,
            config.voterRoot,
            count
        );
    }

    /// @notice End voting now. A pending election is cancelled outright; an active
    ///         secret ballot moves straight into its reveal window.
    function closeElection(uint256 electionId) external onlyRole(ELECTION_ADMIN_ROLE) electionExists(electionId) {
        Election storage e = _elections[electionId];
        Status s = _status(e);

        if (s == Status.Pending) {
            e.cancelled = true;
        } else if (s == Status.Active) {
            e.endTime = uint64(block.timestamp);
        } else {
            revert WrongStatus(electionId, s);
        }
        e.closedEarly = true;

        emit ElectionClosed(electionId, msg.sender, e.cancelled);
    }

    /// @notice Emergency stop: blocks voting, reveals and election creation. Deadlines keep running.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Open ballot voting
    // ---------------------------------------------------------------------

    /// @notice Cast one vote for `proposalIndex` (0-based) in an open-ballot election.
    /// @param proof Merkle proof of eligibility; empty for public elections.
    function vote(uint256 electionId, uint256 proposalIndex, bytes32[] calldata proof) external {
        _vote(electionId, proposalIndex, msg.sender, proof);
    }

    /// @notice Gasless voting: submit a vote signed off-chain by `voter` (EIP-712).
    ///         Anyone may relay it; the vote is always credited to `voter`.
    /// @dev Supports EOAs (ECDSA) and smart-contract wallets (ERC-1271).
    function voteBySig(
        uint256 electionId,
        uint256 proposalIndex,
        address voter,
        uint256 deadline,
        bytes32[] calldata proof,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(VOTE_TYPEHASH, electionId, proposalIndex, voter, _useNonce(voter), deadline))
        );
        if (!SignatureChecker.isValidSignatureNow(voter, digest, signature)) revert InvalidSignature();

        _vote(electionId, proposalIndex, voter, proof);
    }

    // ---------------------------------------------------------------------
    // Secret ballot voting (commit-reveal)
    // ---------------------------------------------------------------------

    /// @notice Commit to a hidden vote. Build `commitment` with {computeCommitment}
    ///         off-chain and keep the salt secret until the reveal window.
    function commitVote(uint256 electionId, bytes32 commitment, bytes32[] calldata proof) external whenNotPaused {
        Election storage e = _getActive(electionId);
        if (e.revealDuration == 0) revert WrongBallotType(electionId);
        if (commitment == bytes32(0)) revert EmptyCommitment();
        _checkVoter(e, electionId, msg.sender, proof);

        hasVoted[electionId][msg.sender] = true;
        commitments[electionId][msg.sender] = commitment;
        unchecked {
            ++e.totalCommits;
        }

        emit VoteCommitted(electionId, msg.sender, commitment);
    }

    /// @notice Reveal a previously committed vote during the reveal window.
    function revealVote(uint256 electionId, uint256 proposalIndex, bytes32 salt) external whenNotPaused {
        Election storage e = _get(electionId);
        Status s = _status(e);
        if (s != Status.Revealing) revert WrongStatus(electionId, s);

        bytes32 stored = commitments[electionId][msg.sender];
        if (stored == bytes32(0)) revert NoCommitment(electionId, msg.sender);
        if (hasRevealed[electionId][msg.sender]) revert AlreadyRevealed(electionId, msg.sender);
        if (computeCommitment(electionId, proposalIndex, salt, msg.sender) != stored) {
            revert CommitmentMismatch(electionId, msg.sender);
        }
        if (proposalIndex >= e.voteCounts.length) revert InvalidProposal(electionId, proposalIndex);

        hasRevealed[electionId][msg.sender] = true;
        unchecked {
            ++e.voteCounts[proposalIndex];
            ++e.totalVotes;
        }

        emit VoteRevealed(electionId, msg.sender, proposalIndex);
    }

    /// @notice The commitment a voter must submit. Binding the election and voter
    ///         prevents a commitment from being copied by someone else or replayed elsewhere.
    function computeCommitment(
        uint256 electionId,
        uint256 proposalIndex,
        bytes32 salt,
        address voter
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(electionId, proposalIndex, salt, voter));
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function electionCount() external view returns (uint256) {
        return _elections.length;
    }

    function status(uint256 electionId) external view returns (Status) {
        return _status(_get(electionId));
    }

    function getElection(uint256 electionId) public view returns (ElectionView memory v) {
        Election storage e = _get(electionId);
        v.id = electionId;
        v.title = e.title;
        v.creator = e.creator;
        v.startTime = e.startTime;
        v.endTime = e.endTime;
        v.revealEndTime = e.endTime + e.revealDuration;
        v.secret = e.revealDuration > 0;
        v.closedEarly = e.closedEarly;
        v.cancelled = e.cancelled;
        v.voterRoot = e.voterRoot;
        v.totalCommits = e.totalCommits;
        v.totalVotes = e.totalVotes;
        v.status = _status(e);
        v.proposalNames = e.proposalNames;
        v.voteCounts = e.voteCounts;
    }

    /// @notice Page through elections in creation order.
    function getElections(uint256 offset, uint256 limit) external view returns (ElectionView[] memory page) {
        uint256 total = _elections.length;
        if (offset >= total) return new ElectionView[](0);
        uint256 end = limit > total - offset ? total : offset + limit;
        page = new ElectionView[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = getElection(i);
        }
    }

    function getResults(uint256 electionId) external view returns (uint256[] memory) {
        return _get(electionId).voteCounts;
    }

    /// @notice Whether `voter` is on the election's allowlist given `proof` (ignores timing and prior votes).
    function isEligible(uint256 electionId, address voter, bytes32[] calldata proof) external view returns (bool) {
        return _isEligible(_get(electionId).voterRoot, voter, proof);
    }

    /// @notice Final outcome of an ended election.
    /// @return outcome NoVotes, Winner or Tie.
    /// @return winnerIndex Winning proposal index (meaningful only when outcome == Winner).
    /// @return topVotes Highest vote count received by any proposal.
    function getOutcome(
        uint256 electionId
    ) public view returns (Outcome outcome, uint256 winnerIndex, uint256 topVotes) {
        Election storage e = _get(electionId);
        if (_status(e) != Status.Ended) revert ElectionNotEnded(electionId);
        if (e.totalVotes == 0) return (Outcome.NoVotes, 0, 0);

        // Single pass: track the leader and whether the lead is shared.
        bool tied = false;
        uint256 count = e.voteCounts.length;
        for (uint256 i = 0; i < count; ++i) {
            uint256 votes = e.voteCounts[i];
            if (votes > topVotes) {
                topVotes = votes;
                winnerIndex = i;
                tied = false;
            } else if (votes == topVotes) {
                tied = true;
            }
        }

        return tied ? (Outcome.Tie, 0, topVotes) : (Outcome.Winner, winnerIndex, topVotes);
    }

    /// @notice Human-readable result: the winning proposal's name, "Tie" or "No votes cast".
    function getWinner(uint256 electionId) external view returns (string memory) {
        (Outcome outcome, uint256 winnerIndex, ) = getOutcome(electionId);
        if (outcome == Outcome.NoVotes) return "No votes cast";
        if (outcome == Outcome.Tie) return "Tie";
        return _elections[electionId].proposalNames[winnerIndex];
    }

    /// @notice EIP-712 domain separator, exposed for off-chain signers.
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _vote(
        uint256 electionId,
        uint256 proposalIndex,
        address voter,
        bytes32[] calldata proof
    ) private whenNotPaused {
        Election storage e = _getActive(electionId);
        if (e.revealDuration != 0) revert WrongBallotType(electionId);
        if (proposalIndex >= e.voteCounts.length) revert InvalidProposal(electionId, proposalIndex);
        _checkVoter(e, electionId, voter, proof);

        // Checks-effects only: this function makes no external calls.
        hasVoted[electionId][voter] = true;
        unchecked {
            // Each address votes at most once per election, so these cannot overflow.
            ++e.voteCounts[proposalIndex];
            ++e.totalVotes;
        }

        emit VoteCast(electionId, voter, proposalIndex);
    }

    function _checkVoter(Election storage e, uint256 electionId, address voter, bytes32[] calldata proof) private view {
        if (hasVoted[electionId][voter]) revert AlreadyVoted(electionId, voter);
        if (!_isEligible(e.voterRoot, voter, proof)) revert NotEligible(electionId, voter);
    }

    function _get(uint256 electionId) private view returns (Election storage) {
        if (electionId >= _elections.length) revert ElectionNotFound(electionId);
        return _elections[electionId];
    }

    function _getActive(uint256 electionId) private view returns (Election storage e) {
        e = _get(electionId);
        Status s = _status(e);
        if (s != Status.Active) revert WrongStatus(electionId, s);
    }

    function _status(Election storage e) private view returns (Status) {
        if (e.cancelled) return Status.Ended;
        if (block.timestamp < e.startTime) return Status.Pending;
        if (block.timestamp < e.endTime) return Status.Active;
        if (block.timestamp < uint256(e.endTime) + e.revealDuration) return Status.Revealing;
        return Status.Ended;
    }

    function _isEligible(bytes32 root, address voter, bytes32[] calldata proof) private pure returns (bool) {
        if (root == bytes32(0)) return true;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(voter))));
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }
}

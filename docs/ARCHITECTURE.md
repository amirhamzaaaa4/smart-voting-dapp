# Architecture

## Overview

SmartVoting is three deployable pieces around one contract:

| Component         | Tech                                  | Responsibility                                          |
| ----------------- | ------------------------------------- | ------------------------------------------------------- |
| `ElectionManager` | Solidity 0.8.28, OpenZeppelin 5       | Source of truth: elections, eligibility, votes, results |
| dApp              | React 19, TypeScript, Vite, ethers v6 | Reads state and events; builds and signs transactions   |
| Relayer           | Node.js, ethers v6                    | Optional: submits EIP-712-signed votes and pays gas     |

There is deliberately **no backend database**. Everything the UI shows comes from contract reads (`getElections`) and events (the audit trail), so anyone can independently verify what they see.

## Contract design

### One contract, many elections

A single `ElectionManager` stores an array of `Election` structs instead of deploying a new contract per election (a factory). The trade-offs:

- ✅ One address to audit, verify, monitor and integrate with
- ✅ Creating an election costs ~260k gas instead of a full contract deployment (1M+)
- ✅ Shared role management and a single pause switch
- ⚠️ A bug would affect all elections. Mitigations: the pause switch, 100% test coverage, invariant tests and static analysis.

### Storage

```solidity
struct Election {
    string title;
    address creator;
    uint64 startTime;
    uint64 endTime;          // set to block.timestamp on early close
    uint64 revealDuration;   // 0 => open ballot
    bool closedEarly;
    bool cancelled;
    bytes32 voterRoot;       // 0 => public
    uint256 totalCommits;
    uint256 totalVotes;
    string[] proposalNames;
    uint256[] voteCounts;
}

mapping(uint256 => mapping(address => bool))    hasVoted;     // voted or committed
mapping(uint256 => mapping(address => bytes32)) commitments;
mapping(uint256 => mapping(address => bool))    hasRevealed;
```

The `uint64` timestamps and the booleans pack into shared storage slots. Status is **derived, never stored** (see `_status`): it is computed from timestamps and flags, so it can never drift out of sync with time.

### Status machine

| Status      | Condition (evaluated in order)                                                |
| ----------- | ----------------------------------------------------------------------------- |
| `Ended`     | `cancelled`                                                                   |
| `Pending`   | `now < startTime`                                                             |
| `Active`    | `now < endTime`                                                               |
| `Revealing` | `now < endTime + revealDuration` (secret ballots only; zero-length otherwise) |
| `Ended`     | otherwise                                                                     |

`closeElection` acts on the current status: **Pending → cancel**, **Active → `endTime = now`**. Moving `endTime` (rather than setting a separate flag) means a secret ballot that is closed early still gets its full reveal window.

### Outcome

`getOutcome` makes one pass over at most 20 counts, tracking the leader and whether the lead is shared. A tie for first place always produces `Tie`; options are never favored by their position. A tie _below_ first place (e.g. `2,1,1`) is correctly reported as a winner. Each of these cases has a test.

### Secret ballots

```
commitment = keccak256(abi.encode(electionId, proposalIndex, salt, voter))
```

- `electionId` stops a commitment being replayed in another election.
- `voter` stops a commitment being copied. Bob can submit Alice's hash, but he can never reveal it.
- `salt` (32 random bytes, generated client-side) stops anyone brute-forcing the small set of possible choices.
- An invalid choice can be committed, because the contract cannot see inside the hash. It then fails on reveal, like a spoiled paper ballot.

The dApp saves the salt to `localStorage` _before_ sending the transaction, and downloads a JSON receipt as a backup.

### Gasless voting

```
Vote(uint256 electionId, uint256 proposalIndex, address voter, uint256 nonce, uint256 deadline)
```

- The EIP-712 domain (`name`, `version`, `chainId`, `verifyingContract`) prevents replay across chains and contracts. The dApp reads the domain via ERC-5267 `eip712Domain()` rather than hard-coding it.
- OpenZeppelin `Nonces` makes every signature single-use.
- `SignatureChecker` accepts both EOAs (ECDSA) and smart-contract wallets (ERC-1271).
- The vote is credited to `voter`, never to `msg.sender`, so the relayer has no say in what is recorded.

### Allowlists

Leaves follow OpenZeppelin's `StandardMerkleTree` format: `keccak256(bytes.concat(keccak256(abi.encode(voter))))`. The double hash prevents second-preimage attacks on the tree. Proofs are published as static JSON (`/allowlists/<root>.json`). They contain no secrets; the on-chain root is what enforces eligibility.

## dApp

- **Reads** use a JSON-RPC provider when one is configured, so the app works before a wallet is connected. Otherwise they go through the injected wallet.
- **Polling** every 4 seconds, rather than websocket subscriptions, keeps it compatible with any RPC provider.
- **Chain clock.** Countdowns tick from the latest block timestamp, not the device clock, because local chains can time-travel and device clocks drift.
- **Errors.** Custom errors are decoded via the ABI and mapped to plain-language messages.

## Relayer

A stateless HTTP service with two endpoints, `POST /relay` and `GET /health`. For each relay request it:

1. Validates types and sizes, and rejects expired deadlines
2. Rate-limits per IP and per voter (in-memory sliding window)
3. Simulates the call with `staticCall` first, so invalid votes cost nothing and return a decoded error
4. Submits through a serialized queue, so concurrent requests never collide on the wallet nonce
5. Writes structured JSON logs

In production you would add persistent rate limiting (e.g. Redis), a gas budget per election, and managed keys (KMS) instead of a raw private key.

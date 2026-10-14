# Changelog

## [2.0.0]: platform rewrite

### Added

- `ElectionManager`: unlimited elections in one contract, each with 2–20 named options
- Secret ballots via commit–reveal, with commitments bound to the voter and election
- Gasless voting via EIP-712 `voteBySig`, with nonces, deadlines and ERC-1271 support
- Merkle-root voter allowlists (OpenZeppelin `StandardMerkleTree` format)
- Role-based access control and an emergency pause
- Scheduled start times, early close, and cancellation of pending elections
- React + TypeScript dApp with an admin console and an on-chain audit trail
- Relayer service, allowlist CLI, deploy and verify scripts, and a one-command local stack
- 97 automated tests (100% coverage), including randomized invariant tests
- CI with linting, coverage, gas report, Slither and a dApp build

### Changed

- Revert strings replaced with typed custom errors
- Outcome calculation generalized to any number of options in a single bounded pass

## [1.0.0]: coursework

- Single three-option ballot with a deadline, owner early close and tie detection (`contracts/legacy/SmartVotingV1.sol`)

# Threat model

> SmartVoting has **not** been professionally audited. This document records its assumptions and known limitations.

## Trust assumptions

| Actor          | Trusted to…                                            | Not trusted to…                                                    |
| -------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Default admin  | Assign roles responsibly                               | n/a: this role can grant any role, so it belongs behind a multisig |
| Election admin | Define fair options, schedules and allowlists          | Alter votes or results (no function exists to do so)               |
| Pauser         | Pause only during incidents                            | Change outcomes (pausing cannot modify state)                      |
| Relayer        | Stay online                                            | Forge, alter or redirect votes (cryptographically impossible)      |
| Voters         | Keep their key safe, and their salt for secret ballots | Vote twice or outside the voting window                            |

## What an admin can and cannot do

**Can:** create elections with any options and allowlist, close an active election early, cancel a pending one, pause the whole system, and grant or revoke roles.

**Cannot:** change any vote, tally, option, allowlist or deadline after creation (other than ending early), extend an election, or delete an election or its history.

An admin _can_ end an election early or pause it at a strategic moment. That is why every such action emits an event and appears in the dApp's audit trail. Real deployments should place these roles behind a multisig and a timelock.

## Known limitations

1. **Pseudonymous, not anonymous.** Votes are linked to addresses. Secret ballots hide choices only _until the reveal_. True anonymity needs zero-knowledge membership proofs (e.g. Semaphore), which is on the roadmap.
2. **Selective reveal.** In a secret ballot, a voter can choose not to reveal after voting closes, and unrevealed votes do not count. A future version could require a deposit that is forfeited if the voter never reveals.
3. **Sybil resistance comes from outside the contract.** Public elections count one vote per _address_, and addresses are free to create. Use an allowlist for anything that matters.
4. **Timestamp precision.** Validators can shift `block.timestamp` by a few seconds. Do not run elections where seconds matter.
5. **Pausing does not extend deadlines.** A long pause near a deadline effectively shortens voting. This is deliberate, so admins cannot extend elections, but it is a trade-off.
6. **Relayer censorship.** A relayer can refuse to relay a vote. Voters can always fall back to a normal `vote` transaction.
7. **Salt loss.** A voter who loses both their browser storage and the downloaded receipt cannot reveal.
8. **Allowlist distribution.** Voters need the published proof files, and publishing them reveals which addresses are eligible.

## Analysis performed

- 100% line, branch, function and statement coverage
- Seeded randomized invariant tests against an off-chain reference model
- Solhint with zero warnings
- Slither static analysis in CI (fails on medium severity or higher)

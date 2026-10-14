# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report them privately using GitHub's [private vulnerability reporting](../../security/advisories/new) for this repository.

Include a description of the issue, its impact, and steps or a test case to reproduce it. You can expect an acknowledgement within 72 hours.

## Scope

- `contracts/ElectionManager.sol`
- `relayer/server.js`
- The dApp in `frontend/`

`contracts/legacy/` is archived coursework and is out of scope.

This project has not been professionally audited and should not be used to secure elections with real stakes until it has been. See [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

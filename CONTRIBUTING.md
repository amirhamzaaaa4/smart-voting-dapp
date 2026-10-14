# Contributing

1. Fork the repo and create a branch: `git checkout -b feat/short-description`
2. Install dependencies: `npm install && npm run frontend:install`
3. Make your change, with tests. Coverage must stay at 100%.
4. Make sure everything passes locally:
   ```bash
   npm run format && npm run lint && npm test && npm run coverage
   npm run frontend:build
   ```
5. Write commit messages using [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`…).
6. Open a pull request that describes the change and its security implications.

Pull requests that change the contract should explain the effect on gas (`npm run test:gas`) and on the [threat model](docs/THREAT-MODEL.md).

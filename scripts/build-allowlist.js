#!/usr/bin/env node
// Builds a Merkle voter allowlist from a file of addresses (one per line, or a JSON array).
//
//   node scripts/build-allowlist.js voters.txt
//
// Prints the root to pass as `voterRoot` when creating an election, and writes
// allowlists/<root>.json (+ a copy the dApp serves) containing every voter's proof.
const fs = require("fs");
const { buildAllowlist } = require("./lib/allowlist");
const { saveAllowlist } = require("./lib/output");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/build-allowlist.js <addresses.txt|addresses.json>");
  process.exit(1);
}

const raw = fs.readFileSync(file, "utf8");
const addresses = raw.trim().startsWith("[")
  ? JSON.parse(raw)
  : raw.split(/[\s,]+/).filter((line) => line && !line.startsWith("#"));

const allowlist = buildAllowlist(addresses);
const name = saveAllowlist(allowlist);

console.log(`Voters:      ${Object.keys(allowlist.voters).length}`);
console.log(`Merkle root: ${allowlist.root}`);
console.log(`Written:     allowlists/${name} and frontend/public/allowlists/${name}`);

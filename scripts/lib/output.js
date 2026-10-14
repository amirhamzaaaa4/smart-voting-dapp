const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const FRONTEND_CONTRACTS = path.join(ROOT, "frontend", "src", "contracts");
const FRONTEND_ALLOWLISTS = path.join(ROOT, "frontend", "public", "allowlists");
const ALLOWLISTS = path.join(ROOT, "allowlists");

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Saves an allowlist where both the repo and the dApp can find it, keyed by Merkle root. */
function saveAllowlist(allowlist) {
  const name = `${allowlist.root}.json`;
  writeJson(path.join(ALLOWLISTS, name), allowlist);
  writeJson(path.join(FRONTEND_ALLOWLISTS, name), allowlist);
  return name;
}

module.exports = { ROOT, FRONTEND_CONTRACTS, writeJson, saveAllowlist };

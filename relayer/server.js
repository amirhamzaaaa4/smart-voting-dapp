#!/usr/bin/env node
// Gasless-voting relayer.
//
// Voters sign an EIP-712 `Vote` message in the browser (no gas, no ETH needed).
// This service checks the request, simulates it, and submits `voteBySig` from
// its own funded wallet. The contract verifies the signature, so a relayer can
// delay or drop a vote but can never forge or alter one.
//
//   npm run relayer
//
// Env: RELAYER_RPC_URL, RELAYER_PRIVATE_KEY, RELAYER_PORT, RELAYER_ALLOWED_ORIGINS
const http = require("http");
const path = require("path");
const fs = require("fs");
const { ethers } = require("ethers");

const PORT = Number(process.env.RELAYER_PORT || 8787);
const RPC_URL = process.env.RELAYER_RPC_URL || "http://127.0.0.1:8545";
const ALLOWED_ORIGINS = (process.env.RELAYER_ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT = { windowMs: 60_000, max: 10 };
// Well-known Hardhat test mnemonic; only ever used when connected to a local chain.
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";

const contracts = path.join(__dirname, "..", "frontend", "src", "contracts");
const deployment = JSON.parse(fs.readFileSync(path.join(contracts, "deployment.json"), "utf8"));
const abi = JSON.parse(fs.readFileSync(path.join(contracts, "ElectionManager.abi.json"), "utf8"));

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

async function createWallet(provider) {
  const { chainId } = await provider.getNetwork();
  if (Number(chainId) !== deployment.chainId) {
    throw new Error(`RPC chainId ${chainId} does not match deployment chainId ${deployment.chainId}`);
  }
  if (process.env.RELAYER_PRIVATE_KEY) return new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
  if (Number(chainId) === 31337) {
    // Last default Hardhat account, so it never collides with the demo voters.
    return ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/19").connect(provider);
  }
  throw new Error("RELAYER_PRIVATE_KEY is required on non-local networks");
}

// ---------------------------------------------------------------------------
// Validation & rate limiting
// ---------------------------------------------------------------------------

const isUint = (v) => typeof v === "string" && /^\d{1,78}$/.test(v);
const isBytes32 = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

function validate(body) {
  const { electionId, proposalIndex, voter, deadline, proof, signature } = body ?? {};
  if (!isUint(electionId)) return "electionId must be a decimal string";
  if (!isUint(proposalIndex)) return "proposalIndex must be a decimal string";
  if (!isUint(deadline)) return "deadline must be a decimal string";
  if (!ethers.isAddress(voter)) return "voter must be an address";
  if (!Array.isArray(proof) || proof.length > 32 || !proof.every(isBytes32)) return "proof must be bytes32[] (max 32)";
  if (!ethers.isHexString(signature) || signature.length > 2 + 2 * 1024) return "signature must be hex";
  if (BigInt(deadline) < BigInt(Math.floor(Date.now() / 1000))) return "signature deadline has passed";
  return null;
}

const hits = new Map();
function rateLimited(key) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > RATE_LIMIT.max;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function send(res, status, body, origin) {
  const allowOrigin = ALLOWED_ORIGINS.includes("*") ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : "";
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
  });
}

function revertReason(err, iface) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (data) {
    try {
      const parsed = iface.parseError(data);
      if (parsed) return parsed.name;
    } catch {
      /* not a known custom error */
    }
  }
  return err?.shortMessage || err?.message || "Transaction would revert";
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = await createWallet(provider);
  const manager = new ethers.Contract(deployment.address, abi, wallet);

  // Serialise submissions so concurrent requests never race on the wallet nonce.
  let queue = Promise.resolve();
  const enqueue = (fn) => (queue = queue.then(fn, fn));

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin || "";
    const ip = req.socket.remoteAddress || "unknown";

    if (req.method === "OPTIONS") return send(res, 204, {}, origin);

    if (req.method === "GET" && req.url === "/health") {
      const balance = await provider.getBalance(wallet.address);
      return send(
        res,
        200,
        {
          ok: true,
          relayer: wallet.address,
          balance: ethers.formatEther(balance),
          chainId: deployment.chainId,
          contract: deployment.address,
        },
        origin,
      );
    }

    if (req.method === "POST" && req.url === "/relay") {
      try {
        const body = await readJson(req);
        const problem = validate(body);
        if (problem) return send(res, 400, { error: problem }, origin);
        if (rateLimited(ip) || rateLimited(body.voter.toLowerCase())) {
          return send(res, 429, { error: "Too many requests, slow down" }, origin);
        }

        const args = [body.electionId, body.proposalIndex, body.voter, body.deadline, body.proof, body.signature];

        // Simulate first: invalid votes cost the relayer nothing.
        try {
          await manager.voteBySig.staticCall(...args);
        } catch (err) {
          return send(res, 422, { error: revertReason(err, manager.interface) }, origin);
        }

        const tx = await enqueue(() => manager.voteBySig(...args));
        log("info", "relayed vote", { voter: body.voter, electionId: body.electionId, tx: tx.hash });
        return send(res, 202, { txHash: tx.hash }, origin);
      } catch (err) {
        log("error", "relay failed", { error: err.message });
        return send(res, err.status || 500, { error: err.status ? err.message : "Relay failed" }, origin);
      }
    }

    send(res, 404, { error: "Not found" }, origin);
  });

  server.listen(PORT, () => {
    log("info", "relayer listening", {
      port: PORT,
      relayer: wallet.address,
      contract: deployment.address,
      chainId: deployment.chainId,
    });
  });
}

main().catch((err) => {
  log("error", "relayer failed to start", { error: err.message });
  process.exit(1);
});

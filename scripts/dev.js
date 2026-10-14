#!/usr/bin/env node
// One command for the full local stack:
//   1. Hardhat node         http://127.0.0.1:8545
//   2. Deploy + seed demo   (writes frontend/src/contracts/*)
//   3. Gasless relayer      http://127.0.0.1:8787
//   4. dApp (Vite)          http://127.0.0.1:5173
//
//   npm run dev:all        (VERBOSE=1 to see Hardhat node logs)
const { spawn, spawnSync } = require("child_process");
const net = require("net");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WIN = process.platform === "win32";
const PORTS = { chain: 8545, relayer: 8787, web: 5173 };
const COLORS = { chain: 90, deploy: 36, relayer: 35, web: 32 };
const children = [];

const say = (name, msg) => console.log(`\x1b[${COLORS[name]}m[${name}]\x1b[0m ${msg}`);

function run(name, cmd, args, { cwd = ROOT, quiet = false } = {}) {
  // npm/npx are .cmd shims on Windows and need a shell; args here are all constants.
  const child = WIN
    ? spawn([cmd, ...args].join(" "), { cwd, shell: true, env: process.env })
    : spawn(cmd, args, { cwd, env: process.env, detached: true });
  const pipe = (stream, out) =>
    stream.on("data", (buf) => {
      if (quiet) return;
      for (const line of buf.toString().split(/\r?\n/)) {
        if (line.trim()) out.write(`\x1b[${COLORS[name]}m[${name}]\x1b[0m ${line}\n`);
      }
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  children.push(child);
  return child;
}

const exited = (child) =>
  new Promise((resolve, reject) =>
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`step failed (exit ${code})`)))),
  );

const portInUse = (port) =>
  new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

async function waitFor(check, what, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Ready means it answers JSON-RPC, not just that something holds the port. */
const chainReady = async () => {
  const res = await fetch(`http://127.0.0.1:${PORTS.chain}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  return (await res.json()).result === "0x7a69"; // 31337
};

function shutdown(code = 0) {
  for (const c of children) {
    if (c.exitCode !== null) continue;
    // Kill the whole tree, otherwise the Hardhat node / Vite outlive their shell.
    if (WIN) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-c.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

(async () => {
  for (const [name, port] of Object.entries(PORTS)) {
    if (await portInUse(port)) {
      throw new Error(`Port ${port} (${name}) is already in use. Stop the other process and try again.`);
    }
  }

  const chain = run("chain", "npx", ["hardhat", "node"], { quiet: !process.env.VERBOSE });
  chain.on("exit", (code) => code && shutdown(1));
  await waitFor(chainReady, "the Hardhat node");
  say("chain", `Hardhat node ready on http://127.0.0.1:${PORTS.chain}`);

  await exited(run("deploy", "npx", ["hardhat", "run", "scripts/deploy.js", "--network", "localhost"]));

  run("relayer", "node", ["relayer/server.js"]);
  run("web", "npm", ["run", "dev", "--", "--host", "127.0.0.1", "--strictPort"], {
    cwd: path.join(ROOT, "frontend"),
  });
  await waitFor(() => portInUse(PORTS.web), "the dApp dev server");

  console.log(`\n  \x1b[1mSmartVoting is running → http://127.0.0.1:${PORTS.web}\x1b[0m`);
  console.log("  Connect → pick a 'Local demo account'. Account #0 is the admin. Ctrl+C to stop.\n");
})().catch((err) => {
  console.error(`\x1b[31m${err.message}\x1b[0m`);
  shutdown(1);
});

// An Ethereum node that runs entirely in the browser, for the public live demo.
//
// It executes real EVM bytecode with @ethereumjs/vm (the reference JavaScript
// EVM) and exposes the standard EIP-1193 `request()` interface, so the dApp
// talks to it exactly as it would to MetaMask or a JSON-RPC node. Nothing leaves
// the visitor's browser and no wallet, test ETH or server is required.
//
// Scope: the JSON-RPC methods ethers v6 uses, unlocked demo accounts, one
// transaction per block, and evm_increaseTime / evm_mine for time travel.
import { createVM, runTx, type VM } from "@ethereumjs/vm";
import { createCustomCommon, Hardfork, Mainnet } from "@ethereumjs/common";
import { createLegacyTx } from "@ethereumjs/tx";
import { createBlock, type Block } from "@ethereumjs/block";
import { Account, bytesToHex, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { HDNodeWallet, TypedDataEncoder, Wallet, getAddress, keccak256, toBeHex, toUtf8Bytes } from "ethers";

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
const BASE_FEE = 7n;
const BLOCK_GAS_LIMIT = 30_000_000n;
const DEFAULT_GAS = 5_000_000n;

type Hex = `0x${string}`;
const hex = (n: bigint | number) => toBeHex(n) as Hex;
const ZERO_HASH = ("0x" + "00".repeat(32)) as Hex;
const ZERO_ADDRESS = "0x" + "00".repeat(20);

interface StoredLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  logIndex: number;
}

interface StoredTx {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  nonce: bigint;
  gasLimit: bigint;
  value: bigint;
  input: Hex;
  v: bigint;
  r: bigint;
  s: bigint;
  blockNumber: number;
  status: 0 | 1;
  gasUsed: bigint;
  contractAddress: Hex | null;
  logs: StoredLog[];
}

interface StoredBlock {
  number: number;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
  gasUsed: bigint;
  txs: Hex[];
}

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: Hex,
  ) {
    super(message);
  }
}

export interface InBrowserChain {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  accounts: string[];
}

export async function createInBrowserChain({
  chainId = 31337,
  accountCount = 20,
  balance = 10_000n * 10n ** 18n,
}: { chainId?: number; accountCount?: number; balance?: bigint } = {}): Promise<InBrowserChain> {
  const common = createCustomCommon({ chainId }, Mainnet, { hardfork: Hardfork.Cancun });
  const vm: VM = await createVM({ common });

  // Same well-known keys as Hardhat's default accounts, so demo addresses match local dev.
  const wallets = Array.from({ length: accountCount }, (_, i) =>
    HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`),
  );
  const keyOf = new Map(wallets.map((w) => [w.address.toLowerCase(), w]));
  for (const w of wallets) {
    await vm.stateManager.putAccount(createAddressFromString(w.address), new Account(0n, balance));
  }

  // ---------------------------------------------------------------------------
  // Chain bookkeeping
  // ---------------------------------------------------------------------------

  let timeOffset = 0;
  const genesisTime = Math.floor(Date.now() / 1000);
  const blocks: StoredBlock[] = [
    {
      number: 0,
      hash: keccak256(toUtf8Bytes("genesis")) as Hex,
      parentHash: ZERO_HASH,
      timestamp: genesisTime,
      gasUsed: 0n,
      txs: [],
    },
  ];
  const txs = new Map<string, StoredTx>();
  const latest = () => blocks[blocks.length - 1];
  const nextTimestamp = () => Math.max(latest().timestamp + 1, Math.floor(Date.now() / 1000) + timeOffset);

  const header = (number: number, timestamp: number) =>
    createBlock(
      {
        header: {
          number: BigInt(number),
          timestamp: BigInt(timestamp),
          gasLimit: BLOCK_GAS_LIMIT,
          baseFeePerGas: BASE_FEE,
        },
      },
      { common, skipConsensusFormatValidation: true },
    );

  function sealBlock(timestamp: number, gasUsed: bigint, txHashes: Hex[]) {
    const number = latest().number + 1;
    blocks.push({
      number,
      hash: keccak256(toUtf8Bytes(`block-${number}-${timestamp}`)) as Hex,
      parentHash: latest().hash,
      timestamp,
      gasUsed,
      txs: txHashes,
    });
    return number;
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  /** Runs a read-only call against current state and rolls back any changes. */
  async function call(tx: { from?: string; to?: string; data?: string; value?: string; gas?: string }) {
    const block: Block = header(latest().number + 1, nextTimestamp());
    await vm.stateManager.checkpoint();
    try {
      const res = await vm.evm.runCall({
        caller: createAddressFromString(tx.from ?? ZERO_ADDRESS),
        to: tx.to ? createAddressFromString(tx.to) : undefined,
        data: tx.data ? hexToBytes(tx.data as Hex) : new Uint8Array(),
        value: tx.value ? BigInt(tx.value) : 0n,
        gasLimit: tx.gas ? BigInt(tx.gas) : DEFAULT_GAS,
        block,
        skipBalance: true,
      });
      const { exceptionError, returnValue, executionGasUsed } = res.execResult;
      if (exceptionError) throw new RpcError(3, "execution reverted", bytesToHex(returnValue) as Hex);
      return { returnValue: bytesToHex(returnValue) as Hex, gasUsed: executionGasUsed };
    } finally {
      await vm.stateManager.revert();
    }
  }

  async function sendTransaction(tx: { from: string; to?: string; data?: string; value?: string; gas?: string }) {
    const wallet = keyOf.get(tx.from.toLowerCase());
    if (!wallet) throw new RpcError(4100, `Unknown account ${tx.from}`);

    const from = createAddressFromString(wallet.address);
    const nonce = (await vm.stateManager.getAccount(from))?.nonce ?? 0n;
    const signed = createLegacyTx(
      {
        nonce,
        gasPrice: BASE_FEE,
        gasLimit: tx.gas ? BigInt(tx.gas) : DEFAULT_GAS,
        to: tx.to ? createAddressFromString(tx.to) : undefined,
        data: tx.data ? hexToBytes(tx.data as Hex) : undefined,
        value: tx.value ? BigInt(tx.value) : 0n,
      },
      { common },
    ).sign(hexToBytes(wallet.privateKey as Hex));

    const timestamp = nextTimestamp();
    const number = latest().number + 1;
    const result = await runTx(vm, {
      tx: signed,
      block: header(number, timestamp),
      skipBlockGasLimitValidation: true,
      skipHardForkValidation: true,
    });

    const hash = bytesToHex(signed.hash()) as Hex;
    sealBlock(timestamp, result.totalGasSpent, [hash]);
    txs.set(hash, {
      hash,
      from: getAddress(wallet.address) as Hex,
      to: tx.to ? (getAddress(tx.to) as Hex) : null,
      nonce,
      gasLimit: signed.gasLimit,
      value: signed.value,
      input: bytesToHex(signed.data) as Hex,
      v: signed.v ?? 0n,
      r: signed.r ?? 0n,
      s: signed.s ?? 0n,
      blockNumber: number,
      status: result.execResult.exceptionError ? 0 : 1,
      gasUsed: result.totalGasSpent,
      contractAddress: result.createdAddress ? (getAddress(result.createdAddress.toString()) as Hex) : null,
      logs: (result.execResult.logs ?? []).map(([address, topics, data], logIndex) => ({
        address: getAddress(bytesToHex(address)) as Hex,
        topics: topics.map((t) => bytesToHex(t) as Hex),
        data: bytesToHex(data) as Hex,
        logIndex,
      })),
    });
    return hash;
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC formatting
  // ---------------------------------------------------------------------------

  const resolveBlock = (tag: unknown): StoredBlock | undefined => {
    if (tag === undefined || tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized")
      return latest();
    if (tag === "earliest") return blocks[0];
    return blocks[Number(tag)];
  };

  const formatBlock = (b: StoredBlock, full: boolean) => ({
    number: hex(b.number),
    hash: b.hash,
    parentHash: b.parentHash,
    timestamp: hex(b.timestamp),
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    gasLimit: hex(BLOCK_GAS_LIMIT),
    gasUsed: hex(b.gasUsed),
    baseFeePerGas: hex(BASE_FEE),
    miner: ZERO_ADDRESS,
    extraData: "0x",
    logsBloom: "0x" + "00".repeat(256),
    stateRoot: ZERO_HASH,
    transactionsRoot: ZERO_HASH,
    receiptsRoot: ZERO_HASH,
    sha3Uncles: ZERO_HASH,
    mixHash: ZERO_HASH,
    size: "0x0",
    uncles: [],
    transactions: full ? b.txs.map((h) => formatTx(txs.get(h)!)) : b.txs,
  });

  const formatTx = (t: StoredTx) => ({
    hash: t.hash,
    blockHash: blocks[t.blockNumber].hash,
    blockNumber: hex(t.blockNumber),
    transactionIndex: "0x0",
    from: t.from,
    to: t.to,
    nonce: hex(t.nonce),
    gas: hex(t.gasLimit),
    gasPrice: hex(BASE_FEE),
    value: hex(t.value),
    input: t.input,
    type: "0x0",
    chainId: hex(chainId),
    v: hex(t.v),
    r: hex(t.r),
    s: hex(t.s),
  });

  const formatLog = (t: StoredTx, l: StoredLog) => ({
    address: l.address,
    topics: l.topics,
    data: l.data,
    blockNumber: hex(t.blockNumber),
    blockHash: blocks[t.blockNumber].hash,
    transactionHash: t.hash,
    transactionIndex: "0x0",
    logIndex: hex(l.logIndex),
    removed: false,
  });

  const formatReceipt = (t: StoredTx) => ({
    transactionHash: t.hash,
    transactionIndex: "0x0",
    blockHash: blocks[t.blockNumber].hash,
    blockNumber: hex(t.blockNumber),
    from: t.from,
    to: t.to,
    cumulativeGasUsed: hex(t.gasUsed),
    gasUsed: hex(t.gasUsed),
    effectiveGasPrice: hex(BASE_FEE),
    contractAddress: t.contractAddress,
    logs: t.logs.map((l) => formatLog(t, l)),
    logsBloom: "0x" + "00".repeat(256),
    status: hex(t.status),
    type: "0x0",
  });

  function getLogs(filter: {
    fromBlock?: string;
    toBlock?: string;
    address?: string | string[];
    topics?: (string | string[] | null)[];
  }) {
    const from = resolveBlock(filter.fromBlock ?? "earliest")?.number ?? 0;
    const to = resolveBlock(filter.toBlock ?? "latest")?.number ?? latest().number;
    const addresses = filter.address ? [filter.address].flat().map((a) => a.toLowerCase()) : null;
    const out: unknown[] = [];
    for (let n = from; n <= to; n++) {
      for (const h of blocks[n]?.txs ?? []) {
        const t = txs.get(h)!;
        for (const l of t.logs) {
          if (addresses && !addresses.includes(l.address.toLowerCase())) continue;
          const matches = (filter.topics ?? []).every((want, i) => {
            if (want === null || want === undefined) return true;
            const options = [want].flat().map((x) => x.toLowerCase());
            return options.includes(l.topics[i]?.toLowerCase());
          });
          if (matches) out.push(formatLog(t, l));
        }
      }
    }
    return out;
  }

  function signerFor(address: string): Wallet {
    const w = keyOf.get(address.toLowerCase());
    if (!w) throw new RpcError(4100, `Unknown account ${address}`);
    return new Wallet(w.privateKey);
  }

  // ---------------------------------------------------------------------------
  // EIP-1193
  // ---------------------------------------------------------------------------

  // Serialize everything: the EVM state is single-threaded.
  let queue: Promise<unknown> = Promise.resolve();

  async function handle(method: string, p: unknown[]): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return hex(chainId);
      case "net_version":
        return String(chainId);
      case "eth_accounts":
      case "eth_requestAccounts":
        return wallets.map((w) => w.address);
      case "eth_blockNumber":
        return hex(latest().number);
      case "eth_gasPrice":
        return hex(BASE_FEE);
      case "eth_maxPriorityFeePerGas":
        return "0x0";
      case "eth_getBalance":
        return hex((await vm.stateManager.getAccount(createAddressFromString(p[0] as string)))?.balance ?? 0n);
      case "eth_getTransactionCount":
        return hex((await vm.stateManager.getAccount(createAddressFromString(p[0] as string)))?.nonce ?? 0n);
      case "eth_getCode":
        return bytesToHex(await vm.stateManager.getCode(createAddressFromString(p[0] as string)));
      case "eth_getBlockByNumber": {
        const b = resolveBlock(p[0]);
        return b ? formatBlock(b, Boolean(p[1])) : null;
      }
      case "eth_getBlockByHash": {
        const b = blocks.find((x) => x.hash === p[0]);
        return b ? formatBlock(b, Boolean(p[1])) : null;
      }
      case "eth_call":
        return (await call(p[0] as Parameters<typeof call>[0])).returnValue;
      case "eth_estimateGas": {
        const { gasUsed } = await call(p[0] as Parameters<typeof call>[0]);
        return hex(21_000n + (gasUsed * 13n) / 10n + 50_000n);
      }
      case "eth_sendTransaction":
        return sendTransaction(p[0] as Parameters<typeof sendTransaction>[0]);
      case "eth_getTransactionByHash": {
        const t = txs.get(p[0] as string);
        return t ? formatTx(t) : null;
      }
      case "eth_getTransactionReceipt": {
        const t = txs.get(p[0] as string);
        return t ? formatReceipt(t) : null;
      }
      case "eth_getLogs":
        return getLogs(p[0] as Parameters<typeof getLogs>[0]);
      case "eth_signTypedData_v4": {
        const typed = typeof p[1] === "string" ? JSON.parse(p[1]) : p[1];
        const types = { ...typed.types };
        delete types.EIP712Domain;
        // Validate encoding first so malformed requests fail clearly.
        TypedDataEncoder.hash(typed.domain, types, typed.message);
        return signerFor(p[0] as string).signTypedData(typed.domain, types, typed.message);
      }
      case "personal_sign":
        return signerFor(p[1] as string).signMessage(hexToBytes(p[0] as Hex));
      case "evm_increaseTime":
        timeOffset += Number(p[0]);
        return hex(timeOffset);
      case "evm_mine":
        sealBlock(nextTimestamp(), 0n, []);
        return "0x0";
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      default:
        throw new RpcError(4200, `Method ${method} is not supported by the in-browser demo chain`);
    }
  }

  return {
    accounts: wallets.map((w) => w.address),
    request({ method, params = [] }) {
      const run = queue.then(() => handle(method, params));
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

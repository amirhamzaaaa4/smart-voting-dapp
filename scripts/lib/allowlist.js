const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
const { getAddress } = require("ethers");

/**
 * Builds an OpenZeppelin StandardMerkleTree over voter addresses.
 * The leaf encoding matches ElectionManager._isEligible:
 *   keccak256(bytes.concat(keccak256(abi.encode(voter))))
 *
 * @param {string[]} addresses
 * @returns {{ root: string, voters: Record<string, string[]> }} root plus a proof per (checksummed) voter
 */
function buildAllowlist(addresses) {
  const unique = [...new Set(addresses.map((a) => getAddress(a.trim())))];
  if (unique.length === 0) throw new Error("Allowlist is empty");

  const tree = StandardMerkleTree.of(
    unique.map((a) => [a]),
    ["address"],
  );
  const voters = {};
  for (const [i, [address]] of tree.entries()) voters[address] = tree.getProof(i);
  return { root: tree.root, voters };
}

module.exports = { buildAllowlist };

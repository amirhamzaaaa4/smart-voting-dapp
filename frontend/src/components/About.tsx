import { DEPLOYMENT } from "../lib/contract";

const FEATURES = [
  {
    icon: "🗳️",
    title: "One address, one vote",
    body: "The contract records every voter per election and rejects repeats, invalid options and out-of-window votes.",
  },
  {
    icon: "🔒",
    title: "Secret ballots",
    body: "Commit–reveal hides choices while voting is open, so early results cannot sway later voters.",
  },
  {
    icon: "⚡",
    title: "Gasless voting",
    body: "Voters sign an EIP-712 message for free; a relayer pays gas. Signatures are bound to the voter and cannot be altered or replayed.",
  },
  {
    icon: "🧾",
    title: "Allowlists at any scale",
    body: "Eligible voters are committed to a single 32-byte Merkle root; each voter proves membership with a short proof.",
  },
  {
    icon: "🛡️",
    title: "Role-based administration",
    body: "Separate roles for creating elections, emergency pause, and granting access. Ready for a multisig admin.",
  },
  {
    icon: "🔎",
    title: "Fully auditable",
    body: "Every election, vote, reveal and closure is an on-chain event shown in each election's audit trail.",
  },
];

export function About() {
  return (
    <div className="page">
      <section className="hero">
        <div>
          <h1>How it works</h1>
          <p className="muted">
            SmartVoting runs elections on an Ethereum smart contract, so the rules are enforced by code and the results
            are publicly verifiable.
          </p>
        </div>
      </section>

      <div className="features">
        {FEATURES.map((f) => (
          <div className="card feature" key={f.title}>
            <span className="feature-icon" aria-hidden>
              {f.icon}
            </span>
            <h3>{f.title}</h3>
            <p className="muted">{f.body}</p>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-title">
          <h2>Election lifecycle</h2>
        </div>
        <ol className="steps">
          <li>
            <strong>Upcoming</strong> — created by an election admin with a schedule, options and eligibility rules.
          </li>
          <li>
            <strong>Voting open</strong> — eligible addresses vote once. Secret ballots submit a sealed hash instead.
          </li>
          <li>
            <strong>Revealing</strong> (secret ballots) — voters reveal their choice and secret; only revealed votes
            count.
          </li>
          <li>
            <strong>Ended</strong> — results are final: a winner, a tie, or no votes.
          </li>
        </ol>
        <p className="muted mono small">
          Contract {DEPLOYMENT.address} · chain {DEPLOYMENT.chainId}
        </p>
      </div>
    </div>
  );
}

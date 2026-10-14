import { useCallback, useEffect, useState } from "react";
import type { EventLog } from "ethers";
import {
  DEPLOYMENT,
  Outcome,
  Status,
  ZERO_ROOT,
  describeError,
  getManager,
  liveStatus,
  outcomeOf,
  type Election,
} from "../lib/contract";
import {
  downloadJson,
  loadAllowlist,
  loadSealedVote,
  newSalt,
  proofFor,
  relayerAvailable,
  saveSealedVote,
  voteGasless,
  type Allowlist,
  type SealedVote,
} from "../lib/ballot";
import { formatDate, formatDuration, pct, shortAddress, shortHash } from "../lib/format";
import type { Roles } from "../lib/hooks";
import { useWallet } from "../lib/wallet";
import { StatusBadge, TypeBadges } from "./Badges";
import { useToast } from "./Toasts";

interface Props {
  election: Election | undefined;
  now: number;
  paused: boolean;
  roles: Roles;
  refresh: () => Promise<void>;
}

export function ElectionDetail({ election: e, now, paused, roles, refresh }: Props) {
  if (!e) {
    return (
      <div className="page">
        <a href="#/" className="back">
          ← All elections
        </a>
        <div className="empty">
          <h3>Election not found</h3>
        </div>
      </div>
    );
  }

  const status = liveStatus(e, now);
  const showTallies = !e.secret || status === Status.Revealing || status === Status.Ended;

  return (
    <div className="page">
      <a href="#/" className="back">
        ← All elections
      </a>

      <section className="detail-head">
        <div className="badges">
          <StatusBadge status={status} cancelled={e.cancelled} />
          <TypeBadges election={e} />
        </div>
        <h1>{e.title}</h1>
        <Timeline e={e} status={status} now={now} />
      </section>

      <div className="detail-grid">
        <div className="stack">
          <Results e={e} status={status} showTallies={showTallies} />
          <AuditLog e={e} />
        </div>
        <div className="stack">
          <VotePanel e={e} status={status} paused={paused} refresh={refresh} />
          {roles.isElectionAdmin && (status === Status.Pending || status === Status.Active) && (
            <AdminActions e={e} status={status} refresh={refresh} />
          )}
          <Facts e={e} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Timeline({ e, status, now }: { e: Election; status: Status; now: number }) {
  const steps = [
    { label: "Opens", at: e.startTime, done: status !== Status.Pending },
    {
      label: e.closedEarly && !e.cancelled ? "Closed early" : "Voting closes",
      at: e.endTime,
      done: status >= Status.Revealing,
    },
    ...(e.secret ? [{ label: "Reveal ends", at: e.revealEndTime, done: status === Status.Ended }] : []),
  ];
  const next =
    status === Status.Pending
      ? `Opens in ${formatDuration(e.startTime - now)}`
      : status === Status.Active
        ? `Voting closes in ${formatDuration(e.endTime - now)}`
        : status === Status.Revealing
          ? `Reveal window closes in ${formatDuration(e.revealEndTime - now)}`
          : null;

  if (e.cancelled) return <p className="muted">This election was cancelled before it opened.</p>;

  return (
    <div className="timeline">
      <ol>
        {steps.map((s) => (
          <li key={s.label} className={s.done ? "tl-done" : ""}>
            <span className="tl-dot" />
            <span className="tl-label">{s.label}</span>
            <span className="tl-time">{formatDate(s.at)}</span>
          </li>
        ))}
      </ol>
      {next && <p className="countdown">{next}</p>}
    </div>
  );
}

function Results({ e, status, showTallies }: { e: Election; status: Status; showTallies: boolean }) {
  const { outcome, winner } = outcomeOf(e);
  const final = status === Status.Ended;

  return (
    <div className="card">
      <div className="card-title">
        <h2>{final ? "Final results" : "Results"}</h2>
        <span className="muted">
          {e.secret ? `${e.totalVotes} of ${e.totalCommits} sealed votes revealed` : `${e.totalVotes} votes`}
        </span>
      </div>

      {final && (
        <div className={`outcome ${outcome === Outcome.Winner ? "outcome-win" : ""}`}>
          {outcome === Outcome.NoVotes && "No votes were cast."}
          {outcome === Outcome.Tie && "Result: tie. No single option received the most votes."}
          {outcome === Outcome.Winner && (
            <>
              <span className="trophy" aria-hidden>
                🏆
              </span>
              <span>
                <strong>{e.proposalNames[winner!]}</strong> wins with {e.voteCounts[winner!]} of {e.totalVotes} votes
              </span>
            </>
          )}
        </div>
      )}

      {!showTallies && (
        <p className="notice">
          🔒 This is a secret ballot. Tallies stay hidden until voting closes and voters reveal their choices, so no one
          can be swayed by early results.
        </p>
      )}

      <ul className="bars">
        {e.proposalNames.map((name, i) => {
          const votes = e.voteCounts[i];
          const p = pct(votes, e.totalVotes);
          const leading = showTallies && e.totalVotes > 0 && votes === Math.max(...e.voteCounts);
          return (
            <li key={i} className={leading ? "leading" : ""}>
              <div className="bar-head">
                <span>{name}</span>
                <span className="mono">{showTallies ? `${votes} · ${p}%` : "—"}</span>
              </div>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: showTallies ? `${p}%` : "0%" }} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function VotePanel({
  e,
  status,
  paused,
  refresh,
}: {
  e: Election;
  status: Status;
  paused: boolean;
  refresh: () => Promise<void>;
}) {
  const { account, signer, readProvider, wrongNetwork } = useWallet();
  const toast = useToast();
  const [choice, setChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [allowlist, setAllowlist] = useState<Allowlist | null>(null);
  const [record, setRecord] = useState({ voted: false, revealed: false });
  const [sealed, setSealed] = useState<SealedVote | null>(null);

  const restricted = e.voterRoot !== ZERO_ROOT;
  const proof = restricted ? proofFor(allowlist, account ?? "") : [];

  useEffect(() => {
    loadAllowlist(e.voterRoot).then(setAllowlist);
  }, [e.voterRoot]);

  const loadRecord = useCallback(async () => {
    if (!account || !readProvider) return;
    const m = getManager(readProvider);
    const [voted, revealed] = await Promise.all([m.hasVoted(e.id, account), m.hasRevealed(e.id, account)]);
    setRecord({ voted, revealed });
    setSealed(loadSealedVote(e.id, account));
  }, [account, readProvider, e.id]);

  useEffect(() => {
    loadRecord();
  }, [loadRecord, e.totalVotes, e.totalCommits]);

  const act = async (label: string, fn: () => Promise<string | void>, success: string) => {
    setBusy(label);
    try {
      const hash = await fn();
      toast("success", success, hash ? `Transaction ${shortHash(hash)}` : undefined);
      await refresh();
      await loadRecord();
    } catch (err) {
      toast("error", "Transaction failed", describeError(err));
    } finally {
      setBusy(null);
    }
  };

  const sendTx = async (
    fn: (m: ReturnType<typeof getManager>) => Promise<{ hash: string; wait: () => Promise<unknown> }>,
  ) => {
    const tx = await fn(getManager(signer!));
    await tx.wait();
    return tx.hash;
  };

  const castVote = () => act("vote", () => sendTx((m) => m.vote(e.id, choice!, proof!)), "Vote recorded on-chain");

  const castGasless = () =>
    act(
      "gasless",
      async () => {
        const hash = await voteGasless(signer!, e.id, choice!, proof!);
        await readProvider!.waitForTransaction(hash);
        return hash;
      },
      "Vote relayed — you paid no gas",
    );

  const sealVote = () =>
    act(
      "commit",
      async () => {
        const salt = newSalt();
        const m = getManager(signer!);
        const commitment = await m.computeCommitment(e.id, choice!, salt, account!);
        const vote: SealedVote = {
          electionId: e.id,
          proposalIndex: choice!,
          salt,
          voter: account!,
          contract: DEPLOYMENT.address,
          chainId: DEPLOYMENT.chainId,
        };
        // Save the secret before sending, so it is never lost if the tx confirms but the tab closes.
        saveSealedVote(vote);
        downloadJson(`vote-receipt-election-${e.id}.json`, vote);
        return sendTx((mm) => mm.commitVote(e.id, commitment, proof!));
      },
      "Sealed vote submitted",
    );

  const reveal = (v: SealedVote) =>
    act("reveal", () => sendTx((m) => m.revealVote(e.id, v.proposalIndex, v.salt)), "Vote revealed and counted");

  const onReceipt = async (file: File | undefined) => {
    if (!file) return;
    try {
      const v = JSON.parse(await file.text()) as SealedVote;
      if (v.electionId !== e.id || v.voter.toLowerCase() !== account?.toLowerCase()) {
        throw new Error("This receipt belongs to a different election or account.");
      }
      saveSealedVote(v);
      setSealed(v);
    } catch (err) {
      toast("error", "Invalid receipt", describeError(err));
    }
  };

  // ---- render ---------------------------------------------------------------

  const body = (() => {
    if (status === Status.Pending) return <p className="muted">Voting has not opened yet.</p>;
    if (status === Status.Ended) return <p className="muted">This election has ended. Results are final.</p>;
    if (!account) return <p className="muted">Connect a wallet to take part.</p>;
    if (wrongNetwork) return <p className="muted">Switch your wallet to the correct network.</p>;
    if (paused) return <p className="muted">Voting is temporarily paused.</p>;
    if (restricted && !proof)
      return (
        <p className="notice notice-error">
          {allowlist
            ? "Your address is not on this election's voter allowlist."
            : "Voter allowlist could not be loaded."}
        </p>
      );

    if (status === Status.Revealing) {
      if (!record.voted) return <p className="muted">You did not submit a sealed vote in this election.</p>;
      if (record.revealed) return <Done text="Your vote has been revealed and counted." />;
      if (!sealed)
        return (
          <div className="stack-sm">
            <p>Upload the receipt you downloaded when you sealed your vote.</p>
            <input type="file" accept="application/json" onChange={(ev) => onReceipt(ev.target.files?.[0])} />
          </div>
        );
      return (
        <div className="stack-sm">
          <p>
            Your sealed choice: <strong>{e.proposalNames[sealed.proposalIndex] ?? `#${sealed.proposalIndex}`}</strong>
          </p>
          <button className="btn btn-primary btn-block" disabled={!!busy} onClick={() => reveal(sealed)}>
            {busy === "reveal" ? "Revealing…" : "Reveal my vote"}
          </button>
          <p className="hint">Unrevealed votes are not counted.</p>
        </div>
      );
    }

    // Active
    if (record.voted) {
      return e.secret ? (
        <Done text="Your sealed vote is recorded. Come back during the reveal window to have it counted." />
      ) : (
        <Done text="Your vote has been recorded." />
      );
    }

    return (
      <div className="stack-sm">
        <fieldset className="options">
          <legend className="sr-only">Choose an option</legend>
          {e.proposalNames.map((name, i) => (
            <label key={i} className={`option ${choice === i ? "selected" : ""}`}>
              <input type="radio" name="choice" checked={choice === i} onChange={() => setChoice(i)} />
              <span>{name}</span>
            </label>
          ))}
        </fieldset>

        {e.secret ? (
          <>
            <button className="btn btn-primary btn-block" disabled={choice === null || !!busy} onClick={sealVote}>
              {busy === "commit" ? "Sealing…" : "Seal my vote"}
            </button>
            <p className="hint">
              Only a hash of your choice goes on-chain. A receipt with your secret is saved in this browser and
              downloaded as a backup; you will need it to reveal.
            </p>
          </>
        ) : (
          <>
            <button className="btn btn-primary btn-block" disabled={choice === null || !!busy} onClick={castVote}>
              {busy === "vote" ? "Submitting…" : "Cast vote"}
            </button>
            {relayerAvailable() && (
              <button
                className="btn btn-secondary btn-block"
                disabled={choice === null || !!busy}
                onClick={castGasless}
              >
                {busy === "gasless" ? "Relaying…" : "⚡ Vote without gas"}
              </button>
            )}
            <p className="hint">
              Gasless voting: you sign a message for free, and a relayer submits it. The contract checks your signature,
              so the relayer cannot change your vote.
            </p>
          </>
        )}
      </div>
    );
  })();

  return (
    <div className="card">
      <div className="card-title">
        <h2>{status === Status.Revealing ? "Reveal your vote" : "Your vote"}</h2>
      </div>
      {body}
    </div>
  );
}

function Done({ text }: { text: string }) {
  return (
    <div className="done">
      <span className="done-icon" aria-hidden>
        ✓
      </span>
      <p>{text}</p>
    </div>
  );
}

function AdminActions({ e, status, refresh }: { e: Election; status: Status; refresh: () => Promise<void> }) {
  const { signer } = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pending = status === Status.Pending;

  const close = async () => {
    const msg = pending
      ? "Cancel this election? It will never open."
      : e.secret
        ? "End voting now and start the reveal window?"
        : "End voting now? Results will become final.";
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      const tx = await getManager(signer!).closeElection(e.id);
      await tx.wait();
      toast("success", pending ? "Election cancelled" : "Voting closed");
      await refresh();
    } catch (err) {
      toast("error", "Could not close election", describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-admin">
      <div className="card-title">
        <h2>Administration</h2>
      </div>
      <button className="btn btn-danger btn-block" disabled={busy} onClick={close}>
        {busy ? "Working…" : pending ? "Cancel election" : "Close voting early"}
      </button>
    </div>
  );
}

function Facts({ e }: { e: Election }) {
  return (
    <div className="card">
      <div className="card-title">
        <h2>Details</h2>
      </div>
      <dl className="facts">
        <dt>Election ID</dt>
        <dd className="mono">{e.id}</dd>
        <dt>Created by</dt>
        <dd className="mono" title={e.creator}>
          {shortAddress(e.creator)}
        </dd>
        <dt>Eligibility</dt>
        <dd>{e.voterRoot === ZERO_ROOT ? "Any address" : "Merkle allowlist"}</dd>
        {e.voterRoot !== ZERO_ROOT && (
          <>
            <dt>Allowlist root</dt>
            <dd className="mono" title={e.voterRoot}>
              {shortHash(e.voterRoot)}
            </dd>
          </>
        )}
        <dt>Contract</dt>
        <dd className="mono" title={DEPLOYMENT.address}>
          {shortAddress(DEPLOYMENT.address)}
        </dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface LogRow {
  key: string;
  block: number;
  tx: string;
  kind: string;
  actor: string;
  detail: string;
}

function AuditLog({ e }: { e: Election }) {
  const { readProvider } = useWallet();
  const [rows, setRows] = useState<LogRow[] | null>(null);

  useEffect(() => {
    if (!readProvider) return;
    const m = getManager(readProvider);
    const from = DEPLOYMENT.deployBlock;
    const label = (i: bigint) => e.proposalNames[Number(i)] ?? `#${i}`;

    Promise.all([
      m.queryFilter(m.filters.ElectionCreated(e.id), from),
      m.queryFilter(m.filters.VoteCast(e.id), from),
      m.queryFilter(m.filters.VoteCommitted(e.id), from),
      m.queryFilter(m.filters.VoteRevealed(e.id), from),
      m.queryFilter(m.filters.ElectionClosed(e.id), from),
    ])
      .then((groups) => {
        const all = (groups.flat() as EventLog[]).map((ev): LogRow => {
          const a = ev.args;
          const base = { key: `${ev.transactionHash}-${ev.index}`, block: ev.blockNumber, tx: ev.transactionHash };
          switch (ev.eventName) {
            case "ElectionCreated":
              return { ...base, kind: "Created", actor: a.creator, detail: `${a.proposalCount} options` };
            case "VoteCast":
              return { ...base, kind: "Vote", actor: a.voter, detail: label(a.proposalIndex) };
            case "VoteCommitted":
              return { ...base, kind: "Sealed vote", actor: a.voter, detail: shortHash(a.commitment) };
            case "VoteRevealed":
              return { ...base, kind: "Revealed", actor: a.voter, detail: label(a.proposalIndex) };
            default:
              return { ...base, kind: a.cancelled ? "Cancelled" : "Closed early", actor: a.closedBy, detail: "" };
          }
        });
        setRows(all.sort((x, y) => y.block - x.block || y.key.localeCompare(x.key)).slice(0, 50));
      })
      .catch(() => setRows([]));
  }, [readProvider, e.id, e.totalVotes, e.totalCommits, e.closedEarly, e.proposalNames]);

  return (
    <div className="card">
      <div className="card-title">
        <h2>Audit trail</h2>
        <span className="muted">On-chain events, newest first</span>
      </div>
      {rows === null ? (
        <p className="muted">Loading events…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No events yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Block</th>
                <th>Event</th>
                <th>Account</th>
                <th>Detail</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="mono">{r.block}</td>
                  <td>
                    <span className="tag">{r.kind}</span>
                  </td>
                  <td className="mono" title={r.actor}>
                    {shortAddress(r.actor)}
                  </td>
                  <td>{r.detail}</td>
                  <td className="mono" title={r.tx}>
                    {shortHash(r.tx)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

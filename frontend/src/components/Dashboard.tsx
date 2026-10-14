import { useMemo, useState } from "react";
import { Outcome, Status, liveStatus, outcomeOf, type Election } from "../lib/contract";
import { formatDuration } from "../lib/format";
import { StatusBadge, TypeBadges } from "./Badges";

type Filter = "all" | Status;

// Most actionable first: open, then revealing, then upcoming, then finished.
const STATUS_ORDER: Record<Status, number> = {
  [Status.Active]: 0,
  [Status.Revealing]: 1,
  [Status.Pending]: 2,
  [Status.Ended]: 3,
};

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: Status.Active, label: "Open" },
  { key: Status.Pending, label: "Upcoming" },
  { key: Status.Revealing, label: "Revealing" },
  { key: Status.Ended, label: "Ended" },
];

export function Dashboard({ elections, now, loading }: { elections: Election[]; now: number; loading: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const withStatus = useMemo(() => elections.map((e) => ({ e, status: liveStatus(e, now) })), [elections, now]);

  const stats = useMemo(
    () => ({
      total: elections.length,
      open: withStatus.filter((x) => x.status === Status.Active).length,
      ballots: elections.reduce((sum, e) => sum + (e.secret ? e.totalCommits : e.totalVotes), 0),
      ended: withStatus.filter((x) => x.status === Status.Ended).length,
    }),
    [elections, withStatus],
  );

  const shown = withStatus
    .filter((x) => filter === "all" || x.status === filter)
    .filter((x) => x.e.title.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.e.id - a.e.id);

  return (
    <div className="page">
      <section className="hero">
        <div>
          <h1>Elections</h1>
          <p className="muted">
            Every ballot is recorded on-chain: one eligible address, one vote, and results anyone can verify.
          </p>
        </div>
      </section>

      <section className="stats">
        <Stat label="Elections" value={stats.total} />
        <Stat label="Open now" value={stats.open} accent />
        <Stat label="Ballots cast" value={stats.ballots} />
        <Stat label="Completed" value={stats.ended} />
      </section>

      <section className="toolbar">
        <div className="segmented" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={String(f.key)}
              role="tab"
              aria-selected={filter === f.key}
              className={filter === f.key ? "active" : ""}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          className="input search"
          type="search"
          placeholder="Search elections"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </section>

      {loading ? (
        <div className="grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card skeleton" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <h3>No elections here yet</h3>
          <p className="muted">
            {elections.length
              ? "Try a different filter."
              : "An election administrator can create one from the Admin page."}
          </p>
        </div>
      ) : (
        <div className="grid">
          {shown.map(({ e, status }) => (
            <ElectionCard key={e.id} election={e} status={status} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? "stat-accent" : ""}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function ElectionCard({ election: e, status, now }: { election: Election; status: Status; now: number }) {
  const timing =
    status === Status.Pending
      ? `Opens in ${formatDuration(e.startTime - now)}`
      : status === Status.Active
        ? `Closes in ${formatDuration(e.endTime - now)}`
        : status === Status.Revealing
          ? `Reveal ends in ${formatDuration(e.revealEndTime - now)}`
          : e.cancelled
            ? "Cancelled before opening"
            : e.closedEarly
              ? "Closed early"
              : "Finished";

  const { outcome, winner } = outcomeOf(e);
  const result =
    status !== Status.Ended
      ? null
      : outcome === Outcome.NoVotes
        ? "No votes cast"
        : outcome === Outcome.Tie
          ? "Result: tie"
          : `Winner: ${e.proposalNames[winner!]}`;

  return (
    <a className="card election-card" href={`#/election/${e.id}`}>
      <div className="card-top">
        <StatusBadge status={status} cancelled={e.cancelled} />
        <span className="muted mono">#{e.id}</span>
      </div>
      <h3>{e.title}</h3>
      <div className="badges">
        <TypeBadges election={e} />
      </div>
      <div className="card-meta">
        <span>{e.proposalNames.length} options</span>
        <span>{e.secret ? `${e.totalCommits} sealed · ${e.totalVotes} revealed` : `${e.totalVotes} votes`}</span>
      </div>
      <div className="card-footer">
        <span className={result ? "result" : "muted"}>{result ?? timing}</span>
        <span className="arrow" aria-hidden>
          →
        </span>
      </div>
    </a>
  );
}

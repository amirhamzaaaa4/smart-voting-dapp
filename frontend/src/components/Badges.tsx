import { STATUS_LABEL, Status, ZERO_ROOT, type Election } from "../lib/contract";

const STATUS_CLASS: Record<Status, string> = {
  [Status.Pending]: "badge-pending",
  [Status.Active]: "badge-active",
  [Status.Revealing]: "badge-revealing",
  [Status.Ended]: "badge-ended",
};

export function StatusBadge({ status, cancelled }: { status: Status; cancelled?: boolean }) {
  return (
    <span className={`badge ${STATUS_CLASS[status]}`}>
      {status === Status.Active && <span className="pulse" aria-hidden />}
      {cancelled ? "Cancelled" : STATUS_LABEL[status]}
    </span>
  );
}

export function TypeBadges({ election }: { election: Election }) {
  return (
    <>
      <span
        className="badge badge-outline"
        title={election.secret ? "Commit–reveal: choices hidden until voting ends" : "Live tallies"}
      >
        {election.secret ? "🔒 Secret ballot" : "Open ballot"}
      </span>
      <span className="badge badge-outline" title={election.voterRoot}>
        {election.voterRoot === ZERO_ROOT ? "Public" : "Allowlist"}
      </span>
    </>
  );
}

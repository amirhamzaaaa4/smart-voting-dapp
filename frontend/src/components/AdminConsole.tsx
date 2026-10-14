import { useState, type FormEvent } from "react";
import { isAddress, getAddress } from "ethers";
import { ROLES, ZERO_ROOT, describeError, getManager } from "../lib/contract";
import { buildAllowlist, downloadJson } from "../lib/ballot";
import { fromLocalInput, toLocalInput } from "../lib/format";
import type { Roles } from "../lib/hooks";
import { useWallet } from "../lib/wallet";
import { useToast } from "./Toasts";

const HOUR = 3600;

export function AdminConsole({
  roles,
  paused,
  now,
  refresh,
}: {
  roles: Roles;
  paused: boolean;
  now: number;
  refresh: () => Promise<void>;
}) {
  const { account } = useWallet();

  if (!account || !(roles.isElectionAdmin || roles.isPauser || roles.isAdmin)) {
    return (
      <div className="page">
        <div className="empty">
          <h3>Administrators only</h3>
          <p className="muted">Connect an account that holds an admin role to manage elections.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <section className="hero">
        <div>
          <h1>Admin console</h1>
          <p className="muted">Create elections, manage access and respond to incidents.</p>
        </div>
        <div className="badges">
          {roles.isAdmin && <span className="badge badge-outline">Default admin</span>}
          {roles.isElectionAdmin && <span className="badge badge-outline">Election admin</span>}
          {roles.isPauser && <span className="badge badge-outline">Pauser</span>}
        </div>
      </section>

      <div className="detail-grid">
        <div className="stack">{roles.isElectionAdmin && <CreateElection now={now} refresh={refresh} />}</div>
        <div className="stack">
          {roles.isPauser && <EmergencyControls paused={paused} refresh={refresh} />}
          {roles.isAdmin && <RoleManager />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CreateElection({ now, refresh }: { now: number; refresh: () => Promise<void> }) {
  const { signer } = useWallet();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [startNow, setStartNow] = useState(true);
  const [start, setStart] = useState(toLocalInput(now + HOUR));
  const [end, setEnd] = useState(toLocalInput(now + 7 * 24 * HOUR));
  const [secret, setSecret] = useState(false);
  const [revealHours, setRevealHours] = useState(24);
  const [restricted, setRestricted] = useState(false);
  const [voters, setVoters] = useState("");
  const [busy, setBusy] = useState(false);

  const voterList = voters
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  const invalidVoters = voterList.filter((v) => !isAddress(v));

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (restricted && (voterList.length === 0 || invalidVoters.length)) {
      toast(
        "error",
        "Fix the allowlist",
        invalidVoters.length ? `Invalid address: ${invalidVoters[0]}` : "Add at least one voter.",
      );
      return;
    }
    setBusy(true);
    try {
      let voterRoot = ZERO_ROOT;
      if (restricted) {
        const list = buildAllowlist([...new Set(voterList.map((v) => getAddress(v)))]);
        voterRoot = list.root;
        // Proofs must be published for voters; see README "Voter allowlists".
        downloadJson(`${list.root}.json`, list);
      }
      const tx = await getManager(signer!).createElection({
        title: title.trim(),
        proposalNames: options.map((o) => o.trim()),
        startTime: startNow ? 0 : fromLocalInput(start),
        endTime: fromLocalInput(end),
        revealDuration: secret ? Math.round(revealHours * HOUR) : 0,
        voterRoot,
      });
      await tx.wait();
      toast(
        "success",
        "Election created",
        restricted ? "Allowlist downloaded — publish it to frontend/public/allowlists/." : undefined,
      );
      setTitle("");
      setOptions(["", ""]);
      await refresh();
      window.location.hash = "#/";
    } catch (err) {
      toast("error", "Could not create election", describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <div className="card-title">
        <h2>New election</h2>
      </div>

      <label className="field">
        <span>Title</span>
        <input className="input" required maxLength={128} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>

      <div className="field">
        <span>Options</span>
        {options.map((o, i) => (
          <div className="row" key={i}>
            <input
              className="input"
              required
              placeholder={`Option ${i + 1}`}
              value={o}
              onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
            />
            {options.length > 2 && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={`Remove option ${i + 1}`}
                onClick={() => setOptions(options.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        {options.length < 20 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOptions([...options, ""])}>
            + Add option
          </button>
        )}
      </div>

      <div className="row-2">
        <label className="field">
          <span>Start</span>
          <label className="check">
            <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} /> Immediately
          </label>
          {!startNow && (
            <input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          )}
        </label>
        <label className="field">
          <span>Voting closes</span>
          <input
            className="input"
            type="datetime-local"
            required
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
      </div>

      <label className="check toggle">
        <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
        <span>
          <strong>Secret ballot</strong>
          <small>Commit–reveal: choices stay hidden until voting closes.</small>
        </span>
      </label>
      {secret && (
        <label className="field">
          <span>Reveal window (hours)</span>
          <input
            className="input"
            type="number"
            min={1}
            max={720}
            value={revealHours}
            onChange={(e) => setRevealHours(Number(e.target.value))}
          />
        </label>
      )}

      <label className="check toggle">
        <input type="checkbox" checked={restricted} onChange={(e) => setRestricted(e.target.checked)} />
        <span>
          <strong>Restrict to an allowlist</strong>
          <small>Only listed addresses can vote. Stored on-chain as a single Merkle root.</small>
        </span>
      </label>
      {restricted && (
        <label className="field">
          <span>
            Voter addresses <small className="muted">({voterList.length} entered)</small>
          </span>
          <textarea
            className="input"
            rows={5}
            placeholder="0x… one per line"
            value={voters}
            onChange={(e) => setVoters(e.target.value)}
          />
          {invalidVoters.length > 0 && <small className="error-text">{invalidVoters.length} invalid address(es)</small>}
        </label>
      )}

      <button className="btn btn-primary" disabled={busy}>
        {busy ? "Creating…" : "Create election"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------

function EmergencyControls({ paused, refresh }: { paused: boolean; refresh: () => Promise<void> }) {
  const { signer } = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (!paused && !window.confirm("Pause all voting and election creation?")) return;
    setBusy(true);
    try {
      const m = getManager(signer!);
      await (await (paused ? m.unpause() : m.pause())).wait();
      toast("success", paused ? "System resumed" : "System paused");
      await refresh();
    } catch (err) {
      toast("error", "Action failed", describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-admin">
      <div className="card-title">
        <h2>Emergency stop</h2>
        <span className={`badge ${paused ? "badge-revealing" : "badge-active"}`}>
          {paused ? "Paused" : "Operational"}
        </span>
      </div>
      <p className="muted">
        Pausing blocks votes, reveals and new elections across the platform. Deadlines keep running.
      </p>
      <button className={`btn btn-block ${paused ? "btn-primary" : "btn-danger"}`} disabled={busy} onClick={toggle}>
        {busy ? "Working…" : paused ? "Resume system" : "Pause system"}
      </button>
    </div>
  );
}

function RoleManager() {
  const { signer, readProvider } = useWallet();
  const toast = useToast();
  const [address, setAddress] = useState("");
  const [role, setRole] = useState<keyof typeof ROLES>("ELECTION_ADMIN");
  const [busy, setBusy] = useState(false);
  const [holds, setHolds] = useState<boolean | null>(null);

  const check = async (addr: string, r: keyof typeof ROLES) => {
    setHolds(isAddress(addr) && readProvider ? await getManager(readProvider).hasRole(ROLES[r], addr) : null);
  };

  const apply = async (grant: boolean) => {
    setBusy(true);
    try {
      const m = getManager(signer!);
      await (await (grant ? m.grantRole(ROLES[role], address) : m.revokeRole(ROLES[role], address))).wait();
      toast("success", grant ? "Role granted" : "Role revoked");
      await check(address, role);
    } catch (err) {
      toast("error", "Role update failed", describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card form">
      <div className="card-title">
        <h2>Access control</h2>
      </div>
      <label className="field">
        <span>Account</span>
        <input
          className="input mono"
          placeholder="0x…"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            check(e.target.value, role);
          }}
        />
      </label>
      <label className="field">
        <span>Role</span>
        <select
          className="input"
          value={role}
          onChange={(e) => {
            const r = e.target.value as keyof typeof ROLES;
            setRole(r);
            check(address, r);
          }}
        >
          <option value="ELECTION_ADMIN">Election admin</option>
          <option value="PAUSER">Pauser</option>
          <option value="DEFAULT_ADMIN">Default admin</option>
        </select>
      </label>
      {holds !== null && (
        <p className="muted">{holds ? "This account holds the role." : "This account does not hold the role."}</p>
      )}
      <div className="row">
        <button
          className="btn btn-primary"
          disabled={busy || !isAddress(address) || holds === true}
          onClick={() => apply(true)}
        >
          Grant
        </button>
        <button
          className="btn btn-ghost"
          disabled={busy || !isAddress(address) || holds === false}
          onClick={() => apply(false)}
        >
          Revoke
        </button>
      </div>
    </div>
  );
}

import { About } from "./components/About";
import { AdminConsole } from "./components/AdminConsole";
import { Dashboard } from "./components/Dashboard";
import { ElectionDetail } from "./components/ElectionDetail";
import { Header } from "./components/Header";
import { useChainClock, usePlatform, useRoles, useRoute } from "./lib/hooks";

export default function App() {
  const route = useRoute();
  const platform = usePlatform();
  const roles = useRoles();
  const now = useChainClock(platform.chainTime);

  const electionMatch = route.match(/^\/election\/(\d+)$/);

  let page;
  if (platform.error && platform.elections.length === 0) {
    page = (
      <div className="page">
        <div className="empty">
          <h3>Can't load elections</h3>
          <p className="muted">{platform.error}</p>
        </div>
      </div>
    );
  } else if (electionMatch) {
    const id = Number(electionMatch[1]);
    page = (
      <ElectionDetail
        election={platform.elections.find((e) => e.id === id)}
        now={now}
        paused={platform.paused}
        roles={roles}
        refresh={platform.refresh}
      />
    );
  } else if (route === "/admin") {
    page = <AdminConsole roles={roles} paused={platform.paused} now={now} refresh={platform.refresh} />;
  } else if (route === "/about") {
    page = <About />;
  } else {
    page = <Dashboard elections={platform.elections} now={now} loading={platform.loading} />;
  }

  return (
    <>
      <Header route={route} roles={roles} paused={platform.paused} />
      <main>{page}</main>
      <footer className="footer">
        <span>SmartVoting · open-source on-chain elections</span>
        <a href="#/about">How it works</a>
      </footer>
    </>
  );
}

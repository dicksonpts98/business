import React, { useEffect, useState } from "react";
import { useApi, post } from "./api";
import { Pill, Tag } from "./ui";
import Command from "./screens/Command";
import Radar from "./screens/Radar";
import Twins from "./screens/Twins";
import Traps from "./screens/Traps";
import Darwin from "./screens/Darwin";
import Arena from "./screens/Arena";
import Skeptic from "./screens/Skeptic";
import Paper from "./screens/Paper";
import Learning from "./screens/Learning";
import Settings from "./screens/Settings";

const NAV: [string, string, any, string][] = [
  ["command", "Command Center", Command, "◎"], ["radar", "Market Radar", Radar, "◌"], ["twins", "Historical Twins", Twins, "≋"], ["traps", "Trap Detector", Traps, "⟁"],
  ["darwin", "Darwin Lab", Darwin, "⌬"], ["arena", "Alpha Arena", Arena, "⚑"], ["skeptic", "Research Skeptic", Skeptic, "⊘"], ["paper", "Paper Trading", Paper, "▤"],
  ["learning", "Learning Monitor", Learning, "↻"], ["settings", "Settings", Settings, "⚙"],
];

export default function App() {
  const [route, setRoute] = useState(location.hash.replace("#/", "").split("?")[0] || "command");
  useEffect(() => { const h = () => setRoute(location.hash.replace("#/", "").split("?")[0] || "command"); addEventListener("hashchange", h); return () => removeEventListener("hashchange", h); }, []);
  const { data: st, error } = useApi("/api/status", 4000);
  const Screen = (NAV.find((n) => n[0] === route) || NAV[0])[2];
  const busy = st?.worker?.current;
  return (
    <div className="h-full flex">
      <nav className="w-52 shrink-0 border-r border-line bg-panel/70 flex flex-col">
        <div className="px-4 py-4 border-b border-line">
          <div className="text-cy font-semibold tracking-[0.2em] text-sm">ALPHA GENESIS</div>
          <div className="text-[10px] text-dim tracking-wider mt-0.5">AUTONOMOUS QUANT RESEARCH</div>
        </div>
        <div className="flex-1 py-2 overflow-y-auto">
          {NAV.map(([k, label, , icon]) => (
            <a key={k} href={`#/${k}`} className={`flex items-center gap-2.5 px-4 py-2 text-[13px] border-l-2 ${route === k ? "border-cy text-text bg-raised" : "border-transparent text-dim hover:text-text hover:bg-raised/50"}`}>
              <span className="w-4 text-center opacity-80">{icon}</span>{label}
            </a>
          ))}
        </div>
        <div className="p-3 border-t border-line text-[11px] space-y-1.5">
          <div className="flex items-center gap-1.5"><span className={`w-1.5 h-1.5 rounded-full ${error ? "bg-dn" : st?.worker?.alive ? "bg-up pulse" : "bg-warn"}`} /><span className="text-dim">{error ? "backend offline" : st?.worker?.alive ? "worker running" : "worker stopped"}</span></div>
          <div className="text-dim truncate">{busy ? <span className="text-cy">▸ {busy.kind.replace("_", " ")}</span> : `${st?.worker?.queued ?? 0} job(s) queued`}</div>
          <div className="text-warn font-semibold tracking-wide">PAPER ONLY</div>
        </div>
      </nav>
      <main className="flex-1 min-w-0 flex flex-col">
        <header className="h-11 shrink-0 border-b border-line flex items-center gap-3 px-4 bg-panel/40">
          <div className="font-medium">{(NAV.find((n) => n[0] === route) || NAV[0])[1]}</div>
          {st && <Tag kind={st.data_kind} />}
          {st?.data_kind === "synthetic" && <span className="text-[11px] text-warn/90 truncate hidden lg:inline">Synthetic market — results demonstrate the machinery, not a real-market edge.</span>}
          <div className="flex-1" />
          {st && <span className="text-[11px] text-dim num hidden md:inline">session {st.last_day} · {st.sessions} sessions · epoch {st.epoch.id}</span>}
          {st?.halt && <Pill v="critical">{st.halt.slice(0, 40)}</Pill>}
          {st?.champion ? <Pill v="CHAMPION">{st.champion.id}</Pill> : st && <Pill v="warn">not trading</Pill>}
        </header>
        <div className="flex-1 overflow-y-auto p-4 fade" key={route}><Screen status={st} /></div>
      </main>
    </div>
  );
}
export const act = async (url: string, after?: () => void) => { try { await post(url); after && setTimeout(after, 600); } catch (e: any) { alert(e.message); } };

import React, { useState } from "react";
import { useApi, f, ago } from "../api";
import { Panel, Tag, Pill, Stat, Btn, Loading } from "../ui";
import { act } from "../App";

export default function Settings() {
  const { data: d, error, refresh } = useApi("/api/settings", 10000);
  const [iv, setIv] = useState("0"), [tok, setTok] = useState(localStorage.getItem("ag_operator_token") || "");
  if (!d) return <Loading error={error} />;
  const kv = (o: any) => <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">{Object.entries(o).map(([k, v]: any) => <div key={k} className="flex justify-between gap-2"><span className="text-dim">{k.replace(/_/g, " ")}</span><span className="num truncate">{Array.isArray(v) ? v.join(", ") : String(v)}</span></div>)}</div>;
  const sch = d.schedules[0];
  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12 xl:col-span-6" title="Data providers" tag={<Tag kind={d.data_kind} />}>
        {d.providers.map((p: any) => <div key={p.name} className="flex items-center gap-2 py-1.5 border-b border-line/50 text-xs"><span className={`w-1.5 h-1.5 rounded-full ${p.active ? "bg-up" : "bg-line"}`} /><span className="flex-1">{p.name}</span>{p.credentials_present === false && <Pill v="na">no credentials</Pill>}<Pill v={p.status.startsWith("verified") ? "pass" : "warn"}>{p.status}</Pill></div>)}
        {(d.mcp || []).map((p: any) => <div key={p.name} className="flex items-center gap-2 py-1.5 border-b border-line/50 text-xs"><span className={`w-1.5 h-1.5 rounded-full ${p.active ? "bg-up" : "bg-line"}`} /><span className="flex-1">{p.name}</span><span className="text-dim text-[11px] max-w-[55%] text-right">{p.status}</span></div>)}
        {d.providers.filter((p: any) => p.report?.summary?.symbols).map((p: any) => (<div key="rep" className="mt-2 text-[11px]"><div className="text-[10px] text-dim uppercase mb-1">Downloaded history (provider manifest)</div>
          {Object.entries(p.report.summary.symbols).map(([k, v]: any) => <div key={k} className="flex justify-between num"><span>{k}</span><span>{v.bars.toLocaleString()} bars · {v.first.slice(0, 10)} → {v.last.slice(0, 10)} · {v.feeds.join("/")}</span></div>)}
          <div className="text-dim mt-1">{p.report.summary.restrictions.length ? `${p.report.summary.restrictions.length} entitlement refusal(s) recorded` : "no entitlement refusals"} · splits: {p.report.summary.splits.map((x: any) => `${x.symbol} ${x.new_rate}:${x.old_rate} ${x.ex_date}`).join(", ") || "none"}</div></div>))}
        <div className="text-[10px] text-dim uppercase mt-3 mb-1">Brokers</div>
        {d.brokers.map((p: any) => <div key={p.name} className="flex items-center gap-2 py-1.5 border-b border-line/50 text-xs"><span className={`w-1.5 h-1.5 rounded-full ${p.active ? "bg-up" : "bg-line"}`} /><span className="flex-1">{p.name}</span><Pill v={p.status.startsWith("verified") ? "pass" : p.status.startsWith("NOT") ? "fail" : "warn"}>{p.status}</Pill></div>)}
        <div className="text-[11px] text-dim mt-2">Credentials are read from environment variables or a git-ignored <span className="num">.env</span> (APCA_API_KEY_ID, APCA_API_SECRET_KEY, ALPHAVANTAGE_API_KEY). Set <span className="num">[data] provider</span> in <span className="num">config/alpha.toml</span>; see docs/OPERATIONS.md.</div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-6" title="Instrument universe and execution assumptions">
        {kv(d.config.universe)}<div className="mt-2">{Object.entries(d.config.instruments).map(([s, v]: any) => <div key={s} className="flex gap-4 text-[11px] py-0.5"><span className="w-12 font-medium">{s}</span><span className="text-dim">half-spread {v.half_spread_bps} bps (modelled)</span><span className="text-dim">{v.shortable ? "shortable" : "not shortable"}</span></div>)}</div>
        <div className="mt-2 pt-2 border-t border-line">{kv(d.config.execution)}</div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Research budgets">{kv(d.config.darwin)}<div className="text-[11px] text-dim mt-2">Edit <span className="num">[darwin]</span> in config/alpha.toml and restart.</div></Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Risk configuration (operator-only file: config/risk.toml)">{kv(d.risk)}</Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Retraining and session schedule">
        {kv(d.config.learning)}
        <div className="mt-2 pt-2 border-t border-line text-xs">Session feed: {sch?.enabled ? <span className="text-up">every {sch.interval_s}s</span> : <span className="text-dim">manual (advance from the Command Center or CLI)</span>}{sch?.last_run ? <span className="text-dim"> · last {ago(sch.last_run)}</span> : null}</div>
        <div className="flex gap-2 mt-2 items-center"><input className="bg-raised border border-line rounded px-2 py-1 text-xs w-20 num" value={iv} onChange={(e) => setIv(e.target.value)} /><span className="text-[11px] text-dim">seconds between sessions (0 = manual)</span><Btn onClick={() => act(`/api/control/schedule?interval_seconds=${+iv || 0}`, refresh)}>Apply</Btn></div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Hardware utilisation">
        <div className="grid grid-cols-2 gap-3"><Stat label="CPU cores" value={d.hardware.cpus} sub={`load ${d.hardware.load.map((x: number) => f(x, 2)).join(" / ")}`} /><Stat label="Memory" value={`${f((d.hardware.memory_mb.MemTotal - (d.hardware.memory_mb.MemAvailable ?? d.hardware.memory_mb.MemFree)) / 1024, 1)} GB`} sub={`of ${f(d.hardware.memory_mb.MemTotal / 1024, 1)} GB in use`} />
          <Stat label="Data directory" value={`${f(d.hardware.data_dir_mb, 0)} MB`} /><Stat label="Disk free" value={`${d.hardware.disk_free_gb} GB`} /></div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Notifications and operator token">
        <div className="text-xs text-dim">Alerts are written to the database and shown in the Command Center; structured JSON logs go to stdout for collection by Docker or a log shipper. No e-mail or chat integration is configured.</div>
        <div className="flex gap-2 mt-3 items-center"><input type="password" placeholder="operator token" className="bg-raised border border-line rounded px-2 py-1 text-xs flex-1" value={tok} onChange={(e) => setTok(e.target.value)} /><Btn onClick={() => { localStorage.setItem("ag_operator_token", tok); alert("saved in this browser"); }}>Save</Btn></div>
        <div className="text-[11px] text-dim mt-1">{d.operator_token_required ? "The server requires AG_OPERATOR_TOKEN for control actions." : "AG_OPERATOR_TOKEN is not set: control actions are open to anyone who can reach this port (bound to 127.0.0.1 by default)."}</div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Backup and recovery" right={<Btn kind="primary" onClick={() => act("/api/control/backup", refresh)}>Create backup</Btn>}>
        <div className="text-xs max-h-28 overflow-y-auto">{d.backups.length ? d.backups.map((b: string) => <div key={b} className="num py-0.5">{b}</div>) : <span className="text-dim">No backups yet.</span>}</div>
        <div className="text-[11px] text-dim mt-2">Restore with <span className="num">python -m alpha_genesis.cli restore data/backups/&lt;name&gt;</span> while the server is stopped.</div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-6" title="Data export (CSV)"><div className="flex flex-wrap gap-1.5">{d.exportable.map((t: string) => <a key={t} href={`/api/export/${t}.csv`} className="px-2 py-1 rounded border border-line text-xs hover:bg-raised">{t}</a>)}</div></Panel>
      <Panel className="col-span-12 xl:col-span-6" title="Dataset versions (provenance and checksums)">
        <div className="max-h-40 overflow-y-auto"><table><thead><tr><th>Version</th><th>Kind</th><th>Sessions</th><th>sha256</th><th>Written</th></tr></thead><tbody>{d.datasets.map((x: any) => <tr key={x.id}><td className="num">{x.version}</td><td><Pill v={x.kind === "synthetic" ? "warn" : "pass"}>{x.kind}</Pill></td><td className="num">{x.n_days}</td><td className="num text-dim">{x.checksum.slice(0, 20)}…</td><td className="text-dim">{ago(x.created)}</td></tr>)}</tbody></table></div>
      </Panel>
    </div>
  );
}

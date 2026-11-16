import React, { useState } from "react";
import { useApi, f, cad, pct, ago } from "../api";
import { Panel, Tag, Lines, Pill, Stat, Btn, Loading, Empty, Hist } from "../ui";
import { act } from "../App";

export default function Skeptic() {
  const { data: d, error, refresh } = useApi("/api/skeptic", 8000);
  const [rid, setRid] = useState<number | null>(null);
  const cur = rid ?? d?.reports?.[0]?.id ?? null;
  const { data: r } = useApi(cur ? `/api/skeptic/report/${cur}` : null, 0);
  if (!d) return <Loading error={error} />;
  const ab = d.ablation, P = d.policy;
  const ck = r?.report?.checks?.checks || [];
  const get = (n: string) => ck.find((c: any) => c.check === n);
  const sens = get("parameter_sensitivity"), abl = get("feature_ablation");
  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12" title="Validation standards — fixed, independent of the strategy generator" right={<span className="text-[10px] text-dim num">policy sha {d.policy_sha.slice(0, 12)}…</span>}>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-4">
          <Stat label="Reviews" value={d.reports.length} sub={`${d.reports.filter((x: any) => x.verdict === "APPROVED").length} approved`} />
          <Stat label="Min validation trades" value={P.min_trades_val} /><Stat label="Min deflated Sharpe" value={P.min_dsr} /><Stat label="Max PBO" value={P.max_pbo} />
          <Stat label="Permutation p ≤" value={P.max_permutation_p} sub={`${P.permutation_samples} controls`} /><Stat label="Neighbours profitable ≥" value={pct(P.min_sensitivity_positive)} />
          <Stat label="Costs / gross ≤" value={pct(P.max_cost_to_gross)} sub="must survive 3× costs" /><Stat label="Holdout budget" value={`${d.holdout_ledger.filter((l: any) => l.purpose === "final_gate").length} used`} sub={`max ${P.max_holdout_uses_per_epoch} per epoch`} />
        </div>
        {Object.keys(d.failure_counts).length > 0 && <div className="mt-3 pt-3 border-t border-line flex flex-wrap gap-2 items-center text-xs"><span className="text-dim">Why candidates were rejected:</span>{Object.entries(d.failure_counts).sort((a: any, b: any) => b[1] - a[1]).map(([k, n]: any) => <Pill key={k} v="fail">{k.replace(/_/g, " ")} × {n}</Pill>)}</div>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Model rejection / approval reports">
        <div className="max-h-[520px] overflow-y-auto">{d.reports.map((x: any) => (<div key={x.id} onClick={() => setRid(x.id)} className={`py-1.5 px-1 border-b border-line/60 cursor-pointer text-xs ${x.id === cur ? "bg-raised" : ""}`}>
          <div className="flex items-center gap-2"><span className="num">{x.strategy_id}</span><Pill v={x.verdict} /><span className="text-dim text-[10px]">cycle {x.cycle_id ?? "—"} · {ago(x.created)}</span></div>
          <div className="flex gap-px mt-1">{Object.entries(x.summary).map(([k, v]: any) => <div key={k} title={`${k}: ${v}`} className="h-1.5 flex-1 rounded-sm" style={{ background: v === "pass" ? "#34d399" : v === "fail" ? "#f87171" : v === "warn" ? "#fbbf24" : "#1c2636" }} />)}</div>
          {x.failed.length > 0 && <div className="text-dn text-[11px] mt-0.5">failed: {x.failed.join(", ").replace(/_/g, " ")}</div>}</div>))}{!d.reports.length && <Empty>No candidate has reached the Skeptic yet.</Empty>}</div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-8" title={r ? `Report #${r.report.id} — ${r.strategy.id}` : "Report"} tag={r && <Tag kind={r.data_kind} seg={r.segment} />} right={r && <Pill v={r.report.verdict} />}>
        {r ? (<>
          <div className="text-xs mb-1">{r.strategy.description}</div>{r.strategy.hypothesis && <div className="text-[11px] text-dim italic mb-2">Hypothesis: {r.strategy.hypothesis}</div>}
          <div className="max-h-72 overflow-y-auto border border-line rounded">{ck.map((c: any) => (<div key={c.check} className="flex gap-2 items-start px-2 py-1 border-b border-line/50 text-xs"><span className="w-12 shrink-0"><Pill v={c.status} /></span><span className="w-40 shrink-0 text-dim">{c.check.replace(/_/g, " ")}</span><span className="whitespace-normal">{c.detail}</span></div>))}</div>
          <div className="grid grid-cols-2 gap-4 mt-3">
            <div><div className="text-[10px] text-dim uppercase mb-1">Validation equity (CAD)</div><Lines height={120} series={[{ name: "net P&L", data: [0, ...(r.report.checks.equity || [])], bold: true }]} fmt={(v: number) => cad(v)} /></div>
            <div><div className="text-[10px] text-dim uppercase mb-1">Sensitivity — net P&L of ±15% parameter neighbours (dashed = as proposed)</div>
              {sens?.neighbor_nets?.length ? <Lines height={120} series={[{ name: "neighbour", data: [...sens.neighbor_nets].sort((a: number, b: number) => a - b), color: "#a78bfa" }, { name: "proposed", data: sens.neighbor_nets.map(() => sens.base_net), dash: true, color: "#64748b" }]} fmt={(v: number) => cad(v)} /> : <Empty>—</Empty>}</div>
          </div>
          {abl?.ablations?.length > 0 && <div className="mt-2 text-xs"><span className="text-dim">Feature ablation (validation net without each condition; proposed {cad(abl.base_net)}): </span>{abl.ablations.map((x: any, i: number) => <span key={i} className="mr-3">{x.removed} → <b className={`num ${x.net_cad > abl.base_net ? "text-warn" : ""}`}>{cad(x.net_cad)}</b></span>)}</div>}
        </>) : <Empty>Select a report.</Empty>}
      </Panel>
      <Panel className="col-span-12" title="Engine contribution — controlled ablations (does each subsystem earn its place?)" tag={ab && <Tag kind={ab.data_kind} seg={`${ab.evaluated_on} · ${ab.window[0]} → ${ab.window[1]}`} />} right={<Btn kind="primary" onClick={() => act("/api/control/ablation", refresh)}>Run ablation study</Btn>}>
        {ab ? (<div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 xl:col-span-7"><table><thead><tr><th>Arm</th><th>What it may use</th><th>Selected on validation</th><th>Net</th><th>Sharpe</th><th>Trades</th><th>vs A / session</th><th>P(better than A)</th></tr></thead>
            <tbody>{Object.entries(ab.arms).map(([k, v]: any) => (<tr key={k}><td className="num font-semibold">{k}</td><td className="whitespace-normal max-w-[200px]">{v.name}</td><td className="whitespace-normal max-w-[260px] text-dim text-[11px]">{v.selected}</td>
              <td className={`num ${v.net_cad >= 0 ? "text-up" : "text-dn"}`}>{cad(v.net_cad)}</td><td className="num">{f(v.sharpe)}</td><td className="num">{v.trades}</td><td className="num">{f(v.vs_A_mean_daily, 1)} [{f(v.vs_A_ci90[0], 0)}, {f(v.vs_A_ci90[1], 0)}]</td><td className="num">{v.prob_better_than_A != null ? pct(v.prob_better_than_A) : "—"}</td></tr>))}</tbody></table>
            <Lines height={150} series={Object.entries(ab.arms).map(([k, v]: any) => ({ name: k, data: [0, ...v.equity] }))} fmt={(v: number) => cad(v)} /></div>
          <div className="col-span-12 xl:col-span-5 text-xs"><div className="text-[10px] text-dim uppercase mb-1">Incremental value of each component (paired block bootstrap)</div>
            {Object.entries(ab.increments).map(([k, v]: any) => (<div key={k} className="flex items-center gap-2 py-1 border-b border-line/50"><Pill v={v.prob_positive >= 0.9 ? "pass" : "warn"}>{v.prob_positive >= 0.9 ? "adds value" : "unproven"}</Pill><span className="flex-1">{k}</span><span className="num">{f(v.mean_daily, 1)} CAD/session · P={pct(v.prob_positive)}</span></div>))}
            <div className="text-[10px] text-dim uppercase mt-3 mb-1">Recommendations</div><ul className="list-disc pl-4 space-y-1">{ab.recommendations.map((x: string, i: number) => <li key={i} className={x.includes("no measurable") ? "text-warn" : ""}>{x}</li>)}</ul>
            <div className="text-dim mt-2">Similarity engine currently {ab.doppelganger_enabled ? "enabled" : "disabled"} for live search. Run {ago(d.ablation_ts)}.</div></div>
        </div>) : <Empty>No ablation study has been run. It compares benchmarks (A), + Doppelgänger (B), + Lie Detector (C), both (D), full Darwin (E) and the full architecture (F) on sessions no arm has searched.</Empty>}
      </Panel>
      <Panel className="col-span-12" title="Holdout ledger — every look at untouched data is recorded">
        <div className="max-h-40 overflow-y-auto"><table><thead><tr><th>When</th><th>Epoch</th><th>Subject</th><th>Purpose</th></tr></thead><tbody>{d.holdout_ledger.map((l: any) => <tr key={l.id}><td className="text-dim">{ago(l.ts)}</td><td className="num">{l.epoch}</td><td className="num">{l.subject}</td><td>{l.purpose}</td></tr>)}</tbody></table>{!d.holdout_ledger.length && <Empty>The holdout has not been touched.</Empty>}</div>
      </Panel>
    </div>
  );
}

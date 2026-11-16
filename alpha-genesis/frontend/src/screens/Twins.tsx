import React, { useState } from "react";
import { useApi, f, pct } from "../api";
import { Panel, Tag, Lines, Hist, Stat, Pill, Loading, Empty, REG, REGC, COLORS } from "../ui";

export default function Twins({ status }: any) {
  const [sym, setSym] = useState("SPY"), [bar, setBar] = useState(42), [method, setMethod] = useState("knn_z"), [day, setDay] = useState("");
  const { data: days } = useApi("/api/days", 60000);
  const { data: d, error } = useApi(`/api/twins?symbol=${sym}&bar=${bar}&method=${method}${day ? `&day=${day}` : ""}`, 0);
  if (!d) return <Loading error={error} />;
  const q = d.query, e = d.engine, fw = q.forward;
  const sel = "bg-raised border border-line rounded px-2 py-1 text-xs";
  const t = (b: number) => { const m = 570 + (b + 1) * 5; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
  return (
    <div className="space-y-3">
      <Panel title="Query — which earlier market states does this moment resemble?">
        <div className="flex flex-wrap gap-2 items-center">
          <select className={sel} value={sym} onChange={(x) => setSym(x.target.value)}>{["SPY", "QQQ", "NVDA", "TSLA"].map((s) => <option key={s}>{s}</option>)}</select>
          <select className={sel} value={day} onChange={(x) => setDay(x.target.value)}><option value="">latest session</option>{(days?.days || []).slice(-250).reverse().map((x: any) => <option key={x.day} value={x.day}>{x.day} · {x.segment}</option>)}</select>
          <label className="text-xs text-dim">time {t(bar)} ET</label><input type="range" min={11} max={77} value={bar} onChange={(x) => setBar(+x.target.value)} className="w-48 accent-cyan-400" />
          <select className={sel} value={method} onChange={(x) => setMethod(x.target.value)}>{Object.entries(d.methods).map(([k, v]: any) => <option key={k} value={k}>{v}</option>)}</select>
          <div className="flex-1" /><Tag kind={d.data_kind} seg={d.segment} />
        </div>
      </Panel>
      <Panel title="Engine status — is historical similarity actually predictive?" right={<Pill v={e.enabled ? "pass" : "fail"}>{e.enabled ? "enabled for strategy search" : "disabled for strategy search"}</Pill>} tag={<Tag kind={d.data_kind} seg="development + validation" />}>
        <div className="text-xs text-dim mb-2">{e.reason}. Scored out-of-sample against an unconditional forecast and the base rate; the holdout is not consulted.</div>
        <table><thead><tr><th>Method</th><th>Rank IC</th><th>IC 90% CI</th><th>MSE skill</th><th>Brier skill</th><th>n</th><th>Verdict</th><th>Why</th></tr></thead>
          <tbody>{Object.entries(e.evaluation).map(([k, v]: any) => (<tr key={k} className={k === e.method ? "bg-raised/60" : ""}><td>{d.methods[k]}</td><td className="num">{f(v.ic, 4)}</td>
            <td className="num">{v.ic_ci90 ? `[${f(v.ic_ci90[0], 3)}, ${f(v.ic_ci90[1], 3)}]` : "—"}</td><td className="num">{f(v.mse_skill_shrunk_vs_unconditional, 4)}</td><td className="num">{f(v.brier_skill, 4)}</td>
            <td className="num">{v.n}</td><td><Pill v={v.pass ? "pass" : "fail"} /></td><td className="text-dim whitespace-normal text-[11px]">{v.reason || ""}</td></tr>))}</tbody></table>
      </Panel>
      {!q.available ? <Panel><Empty>{q.reason}</Empty></Panel> : (
        <div className="grid grid-cols-12 gap-3">
          <Panel className="col-span-12 xl:col-span-4" title={`Market-state fingerprint — ${q.symbol} ${q.day} ${t(q.bar)} ET`} tag={<Pill v="na">{REG[q.regime]}</Pill>}>
            {q.fingerprint.map((x: any) => (
              <div key={x.feature} className="flex items-center gap-2 py-0.5 text-[11px]"><span className="w-20 text-dim">{x.feature}</span>
                <div className="flex-1 h-2 bg-raised rounded relative"><div className="absolute top-0 bottom-0 w-px bg-dim/60 left-1/2" />
                  <div className="absolute top-0 bottom-0 rounded" style={{ left: x.z >= 0 ? "50%" : `${50 + x.z * 10}%`, width: `${Math.min(50, Math.abs(x.z) * 10)}%`, background: x.z >= 0 ? "#22d3ee" : "#a78bfa" }} /></div>
                <span className="num w-12 text-right">{f(x.z, 2)}σ</span></div>))}
            <div className="text-[10px] text-dim mt-2">z-scores use the mean and deviation of earlier sessions only.</div>
          </Panel>
          <Panel className="col-span-12 xl:col-span-4" title={`What followed the ${q.n} matches — next ${fw.horizon_bars} bars`} tag={<Tag seg="outcomes of earlier sessions" />}>
            <Hist counts={fw.hist} lo={-3} hi={3} mark={0} unit="σ" />
            <div className="grid grid-cols-3 gap-3 mt-3">
              <Stat label="Mean" value={`${f(fw.mean_sigma, 2)}σ`} sub={`90% CI [${f(fw.mean_ci90[0], 2)}, ${f(fw.mean_ci90[1], 2)}]`} />
              <Stat label="Share up (raw)" value={pct(fw.p_up_raw)} sub={`calibration slope ${f(e.evaluation[method]?.calibration?.slope, 2)}`} />
              <Stat label="Median adverse move" value={`${f(fw.mae_median_sigma, 2)}σ`} sub={`worst decile ${f(fw.mae_p10_sigma, 2)}σ`} />
            </div>
            <div className="text-[10px] text-dim mt-2">By regime of the match: {Object.entries(q.by_regime).map(([k, v]: any) => `${k} n=${v.n} mean ${f(v.mean_sigma, 2)}σ`).join(" · ") || "—"}</div>
          </Panel>
          <Panel className="col-span-12 xl:col-span-4" title="Why these matches may be unreliable">
            <ul className="text-xs space-y-1.5 list-disc pl-4">{q.caveats.map((c: string, i: number) => <li key={i} className={i < q.caveats.length - 3 ? "text-warn" : "text-dim"}>{c}</li>)}</ul>
          </Panel>
          <Panel className="col-span-12 xl:col-span-7" title="Comparable paths — price relative to the decision bar (bps); vertical centre = decision" tag={<Tag kind={d.data_kind} />}>
            <Lines height={240} fmt={(v: number) => f(v, 0)} series={[{ name: "current (to decision)", data: q.current_path_bps.map((v: any, i: number) => (i <= Math.min(24, q.bar) ? v : null)), color: "#ffffff", bold: true },
              ...q.matches.slice(0, 8).map((m: any, i: number) => ({ name: `${m.symbol} ${m.day}`, data: m.path_bps, color: COLORS[i % COLORS.length], faint: true }))]} />
          </Panel>
          <Panel className="col-span-12 xl:col-span-5" title="Historical matches (one per earlier session)">
            <div className="max-h-64 overflow-y-auto"><table><thead><tr><th>When</th><th>Sym</th><th>Similarity</th><th>Regime</th><th>Then (σ)</th><th>Then (bps)</th></tr></thead>
              <tbody>{q.matches.map((m: any, i: number) => (<tr key={i}><td className="num">{m.day} {t(m.bar)}</td><td>{m.symbol}</td><td className="num">{f(m.similarity, 3)}</td><td style={{ color: REGC[m.regime] }}>{REG[m.regime]}</td>
                <td className={`num ${m.fwd_sigma >= 0 ? "text-up" : "text-dn"}`}>{f(m.fwd_sigma, 2)}</td><td className="num">{f(m.fwd_bps, 1)}</td></tr>))}</tbody></table></div>
          </Panel>
        </div>)}
    </div>
  );
}

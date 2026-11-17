import React, { useState } from "react";
import { useApi, f, cad, pct } from "../api";
import { Panel, Tag, Lines, Pill, Loading, Empty, COLORS, REG } from "../ui";

export default function Arena() {
  const { data: d, error } = useApi("/api/arena", 8000);
  const [win, setWin] = useState("validation"), [sel, setSel] = useState<string | null>(null);
  const a = d?.arena;
  const pick = sel || a?.competitors?.find((c: any) => c.status === "CHAMPION")?.id || a?.competitors?.[0]?.id;
  const { data: tr } = useApi(pick ? `/api/strategy/${pick}/trades?window=${win === "holdout" ? "validation" : win}` : null, 0);
  if (!d) return <Loading error={error} />;
  if (!a) return <Panel><Empty>The arena has not run yet. It runs after every research cycle and every ingested session.</Empty></Panel>;
  const ranked = [...a.competitors].sort((x: any, y: any) => (x.rank ?? 99) - (y.rank ?? 99));
  const col = (c: any) => (c.status === "CHAMPION" ? "#22d3ee" : c.id.includes("NO-TRADE") ? "#475569" : COLORS[(ranked.indexOf(c) + 1) % COLORS.length]);
  const series = ranked.filter((c: any) => c[win]).map((c: any) => ({ name: c.id, data: [0, ...c[win].equity], color: col(c), bold: c.status === "CHAMPION" || c.id === pick, faint: c.status === "BASELINE" && c.id !== pick, dash: c.status === "REJECTED" }));
  const h = a.h2h;
  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12" title="Leaderboard — identical capital, costs, information and risk limits" tag={<Tag kind={a.data_kind} seg="post-selection out-of-sample" />}>
        <div className="text-[11px] text-dim mb-2">Ranked by: {a.ranking_basis}. The no-trade benchmark scores exactly 0 — a champion must beat it. Candidates rejected before the final gate are shown unranked: they were never granted a look at the holdout.</div>
        <div className="overflow-x-auto"><table><thead><tr><th>#</th><th>Strategy</th><th>Status</th><th>Score (LCB)</th><th>OOS net</th><th>OOS Sharpe</th><th>P(mean&gt;0)</th><th>Max DD</th><th>Val net</th><th>Trades/day</th><th>Win</th><th>PF</th><th>Exp. (R)</th><th>Exposure</th><th>Turnover</th><th>Costs</th><th>CVaR 5%</th><th>3× cost net</th><th>Param stab.</th><th>DSR</th></tr></thead>
          <tbody>{ranked.map((c: any) => { const m = c.validation.metrics; return (
            <tr key={c.id} onClick={() => setSel(c.id)} className={`cursor-pointer ${c.id === pick ? "bg-raised" : ""}`} title={c.description}>
              <td className="num">{c.rank ?? "—"}</td><td><span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: col(c) }} /><span className="num">{c.id}</span></td><td><Pill v={c.status} /></td>
              <td className={`num font-semibold ${c.oos ? (c.oos.score > 0 ? "text-up" : c.oos.score < 0 ? "text-dn" : "text-dim") : "text-dim"}`}>{c.oos ? f(c.oos.score, 1) : "n/a"}</td>
              <td className="num">{c.oos ? cad(c.oos.net_cad) : "—"}</td><td className="num">{c.oos ? f(c.oos.sharpe) : "—"}</td><td className="num">{c.oos ? pct(c.oos.prob_positive) : "—"}</td><td className="num text-dn">{c.oos ? cad(c.oos.max_dd_cad) : "—"}</td>
              <td className={`num ${m.net_cad > 0 ? "text-up" : m.net_cad < 0 ? "text-dn" : "text-dim"}`}>{cad(m.net_cad)}</td><td className="num">{f(m.trades_per_day, 1)}</td><td className="num">{pct(m.win_rate)}</td><td className="num">{f(m.profit_factor)}</td><td className="num">{f(m.expectancy_r, 3)}</td>
              <td className="num">{pct(m.exposure)}</td><td className="num">{f(m.turnover_x, 1)}×</td><td className="num" title={m.cost_breakdown_cad ? `commission ${cad(m.cost_breakdown_cad.commission)} · regulatory ${cad(m.cost_breakdown_cad.regulatory, 2)} · spread ${cad(m.cost_breakdown_cad.spread)} · slippage ${cad(m.cost_breakdown_cad.slippage)}` : ""}>{cad(m.cost_cad)}</td><td className="num">{cad(m.cvar5_cad)}</td><td className={`num ${c.validation.stress_net_cad > 0 ? "text-up" : "text-dn"}`}>{cad(c.validation.stress_net_cad)}</td>
              <td className="num">{c.parameter_stability != null ? pct(c.parameter_stability) : "—"}</td><td className="num">{c.dsr != null ? f(c.dsr, 2) : "—"}</td></tr>); })}</tbody></table></div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-8" title="Net equity curves (cumulative CAD P&L)" tag={<Tag kind={a.data_kind} seg={win === "validation" ? "validation" : win === "holdout" ? "holdout (consumed)" : "forward"} />}
        right={<div className="flex gap-1">{["validation", "holdout", "forward"].map((w) => <button key={w} onClick={() => setWin(w)} className={`px-2 py-0.5 rounded text-[11px] border ${win === w ? "border-cy text-cy" : "border-line text-dim"}`}>{w}</button>)}</div>}>
        {series.length ? <Lines series={series} height={300} fmt={(v: number) => cad(v)} /> : <Empty>No results for this window{win === "forward" ? " — no forward sessions yet" : ""}.</Empty>}
        <div className="text-[11px] text-dim mt-1">{a.windows[win] ? `${a.windows[win][0]} → ${a.windows[win][1]}` : ""}{win === "validation" && " · validation was used to select Darwin's candidates, so their curves here are optimistic; baselines were not selected on it."}{win === "holdout" && " · shown only for strategies that were granted their single holdout evaluation, and for untuned baselines."}</div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Head-to-head — P(row beats column), paired bootstrap">
        {h.ids.length ? <div className="overflow-auto max-h-80"><table className="text-[10px]"><thead><tr><th></th>{h.ids.map((id: string, i: number) => <th key={id} title={id} className="text-center">{i + 1}</th>)}</tr></thead>
          <tbody>{h.ids.map((id: string, i: number) => (<tr key={id}><td className="num truncate max-w-[130px]" title={id}>{i + 1}. {id.replace("BASE-", "").replace("-v1", "")}</td>{h.p[i].map((p: any, j: number) => (
            <td key={j} className="num text-center p-0.5"><div className="rounded px-1" style={{ background: p == null ? "transparent" : `rgba(${p > 0.5 ? "52,211,153" : "248,113,113"},${Math.abs(p - 0.5) * 1.2})` }}>{p == null ? "·" : Math.round(p * 100)}</div></td>))}</tr>))}</tbody></table></div> : <Empty>—</Empty>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-7" title={`Trade history — ${pick}`} tag={tr && <Tag kind={tr.data_kind} seg={tr.segment} />}>
        {tr ? (<><div className="text-xs text-dim mb-2">{a.competitors.find((c: any) => c.id === pick)?.description}</div>
          {tr.metrics.cost_breakdown_cad && <div className="flex gap-5 text-xs mb-1">Economics: gross <b className="num">{cad(tr.metrics.gross_cad)}</b> − commission <b className="num">{cad(tr.metrics.cost_breakdown_cad.commission)}</b> − regulatory <b className="num">{cad(tr.metrics.cost_breakdown_cad.regulatory, 2)}</b> − spread <b className="num">{cad(tr.metrics.cost_breakdown_cad.spread)}</b> − slippage <b className="num">{cad(tr.metrics.cost_breakdown_cad.slippage)}</b> = net <b className={`num ${tr.metrics.net_cad >= 0 ? "text-up" : "text-dn"}`}>{cad(tr.metrics.net_cad)}</b> <span className="text-dim">· expectancy {cad(tr.metrics.expectancy_cad, 2)}/trade · FX translation {cad(tr.metrics.fx_translation_cad)}</span></div>}
          <div className="flex gap-5 text-xs mb-2">By regime: {Object.entries(tr.metrics.by_regime).map(([k, v]: any) => <span key={k}>{REG[+k]} <b className={`num ${v.net_cad >= 0 ? "text-up" : "text-dn"}`}>{cad(v.net_cad)}</b> <span className="text-dim">({v.n} trades)</span></span>)}{!Object.keys(tr.metrics.by_regime).length && <span className="text-dim">no trades</span>}</div>
          <div className="max-h-64 overflow-y-auto"><table><thead><tr><th>Day</th><th>Sym</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Why out</th><th>Net</th><th>R</th><th>Cost</th></tr></thead>
            <tbody>{[...tr.trades].reverse().slice(0, 150).map((t: any, i: number) => (<tr key={i}><td className="num">{t.day}</td><td>{t.symbol}</td><td className={t.side > 0 ? "text-up" : "text-dn"}>{t.side > 0 ? "long" : "short"}</td><td className="num">{t.qty}</td><td className="num">{f(t.entry)}</td><td className="num">{f(t.exit)}</td>
              <td className="text-dim">{t.reason}</td><td className={`num ${t.net_cad >= 0 ? "text-up" : "text-dn"}`}>{cad(t.net_cad, 2)}</td><td className="num">{f(t.r)}</td><td className="num text-dim">{cad(t.cost_cad, 2)}</td></tr>))}</tbody></table></div></>) : <Empty>Select a competitor.</Empty>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-5" title="Promotion, demotion, rejection and rollback log (append-only)">
        <div className="text-[11px] text-dim mb-1">Policy: ≥ {d.policy.min_shadow_days} shadow sessions with positive forward P&L, P(beats no-trade) and P(beats champion) ≥ {d.policy.promote_min_prob_beats_champion}. Quarantine: ≥ {d.policy.quarantine_min_trades} paper trades and p &lt; {d.policy.quarantine_p}.</div>
        <div className="max-h-72 overflow-y-auto">{d.promotions.map((r: any) => (<div key={r.id} className="py-1.5 border-b border-line/60 text-xs"><span className="num">{r.strategy_id}</span> <Pill v={r.from_status} /> → <Pill v={r.to_status} />
          <div className="text-dim mt-0.5">{r.reason}</div>{r.evidence?.oos_score != null && <div className="text-[10px] text-dim num">shadow {r.evidence.shadow_days}d · shadow net {cad(r.evidence.shadow_net_cad)} · P(beats champion) {pct(r.evidence.prob_beats_champion)}</div>}</div>))}{!d.promotions.length && <Empty>No lifecycle events yet.</Empty>}</div>
      </Panel>
    </div>
  );
}

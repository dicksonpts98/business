import React from "react";
import { useApi, f, ago, pct } from "../api";
import { Panel, Tag, Lines, Pill, Stat, Loading, Empty, COLORS } from "../ui";

export default function Learning() {
  const { data: d, error } = useApi("/api/learning", 6000);
  if (!d) return <Loading error={error} />;
  const c = d.counts, lc = d.last_cycle, ne = d.next_evaluation;
  const feats = d.drift.length ? Object.keys(d.drift[d.drift.length - 1].payload.psi) : [];
  const lastDrift = d.drift[d.drift.length - 1]?.payload;
  const mids = Array.from(new Set(d.predictions.flatMap((p: any) => Object.keys(p.payload.models || {})))) as string[];
  const dop = d.predictions.filter((p: any) => p.payload.doppelganger);
  const hl = d.health.filter((h: any) => h.payload?.paper_mean_r != null);
  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12" title="Autonomous learning — runs as scheduled jobs; no language model is involved at run time" tag={<Tag kind={d.data_kind} />}>
        <div className="grid grid-cols-2 md:grid-cols-5 xl:grid-cols-10 gap-4">
          <Stat label="Last training cycle" value={lc ? `#${lc.id}` : "—"} sub={lc ? ago(lc.finished) : "none yet"} />
          <Stat label="Next evaluation" value={`${ne.sessions_until_scheduled_cycle} sess.`} sub="until scheduled cycle" />
          <Stat label="Observations added" value={c.sessions_ingested_since_start} sub="sessions since start" />
          <Stat label="Research cycles" value={c.cycles_completed} /><Stat label="Hypotheses" value={c.hypotheses} /><Stat label="Candidates tested" value={c.trials} />
          <Stat label="Skeptic reviews" value={c.candidates_reviewed} sub={`${c.approved} approved`} /><Stat label="Promotions" value={c.promotions} sub={`${c.quarantines} quarantined`} />
          <Stat label="Model versions" value={c.models} sub={`${c.epochs} epoch(s)`} /><Stat label="Failed jobs" value={<span className={d.failed_jobs.length ? "text-dn" : ""}>{d.failed_jobs.length}</span>} />
        </div>
        <div className="text-[11px] text-dim mt-2">Rule: {ne.rule}. {ne.forward_sessions} forward sessions accumulated; a new epoch (fresh holdout + retraining) is locked once {ne.new_epoch_at} are available at a cycle.</div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-7" title="Model drift — population stability index of market-state features (development reference vs latest sessions)" tag={<Tag kind={d.data_kind} seg="forward" />}>
        {d.drift.length > 1 ? <Lines height={200} labels={d.drift.map((x: any) => x.day)} fmt={(v: number) => f(v, 2)} series={[...feats.map((k, i) => ({ name: k, data: d.drift.map((x: any) => x.payload.psi[k]), color: COLORS[i % COLORS.length] })), { name: "alert threshold", data: d.drift.map(() => 0.25), color: "#f87171", dash: true }]} /> : <Empty>Drift is measured after each ingested session.</Empty>}
        {lastDrift && <div className="text-[11px] mt-1">{lastDrift.flagged.length ? <span className="text-warn">Shifted now: {lastDrift.flagged.join(", ")}</span> : <span className="text-dim">No feature is beyond the 0.25 threshold.</span>} <span className="text-dim">A research cycle is triggered when ≥ 3 features shift.</span></div>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-5" title="Champion health — paper expectancy vs its own reference (R per trade)" tag={<Tag kind={d.data_kind} seg="paper trading" />}>
        {hl.length > 1 ? <Lines height={200} labels={hl.map((x: any) => x.day)} fmt={(v: number) => f(v, 2)} series={[{ name: "paper mean R", data: hl.map((x: any) => x.payload.paper_mean_r), bold: true }, { name: "reference mean R", data: hl.map((x: any) => x.payload.reference_mean_r), dash: true, color: "#64748b" }]} /> : <Empty>No champion has traded yet.</Empty>}
        {d.health.length > 0 && <div className="text-[11px] text-dim mt-1">Latest: {d.health[d.health.length - 1].payload ? `${d.health[d.health.length - 1].payload.strategy} — ${d.health[d.health.length - 1].payload.status}, ${d.health[d.health.length - 1].payload.paper_trades} paper trades${d.health[d.health.length - 1].payload.p_deteriorated != null ? `, p(deteriorated) = ${f(d.health[d.health.length - 1].payload.p_deteriorated, 3)}` : ""}` : "no champion"}. Quarantine needs statistical evidence, not a losing streak.</div>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-6" title="Earlier predictions scored against completed outcomes — model Brier score (lower is better)" tag={<Tag kind={d.data_kind} seg="forward" />}>
        {d.predictions.length > 1 && mids.length ? <Lines height={170} zero={false} labels={d.predictions.map((x: any) => x.day)} fmt={(v: number) => f(v, 4)} series={[...mids.map((m, i) => ({ name: m, data: d.predictions.map((x: any) => x.payload.models?.[m]?.recent_brier ?? null), color: COLORS[i] })),
          { name: "base rate", data: d.predictions.map((x: any) => (Object.values(x.payload.models || {})[0] as any)?.recent_base_brier ?? null), dash: true, color: "#64748b" }]} /> : <Empty>Needs completed forward sessions.</Empty>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-6" title="Similarity engine — rolling out-of-sample rank IC" tag={<Tag kind={d.data_kind} seg="forward" />}>
        {dop.length > 1 ? <Lines height={170} labels={dop.map((x: any) => x.day)} fmt={(v: number) => f(v, 3)} series={[{ name: "IC", data: dop.map((x: any) => x.payload.doppelganger.ic), bold: true }, { name: "CI low", data: dop.map((x: any) => x.payload.doppelganger.ic_ci90?.[0] ?? null), color: "#475569" }, { name: "CI high", data: dop.map((x: any) => x.payload.doppelganger.ic_ci90?.[1] ?? null), color: "#475569" }]} /> : <Empty>Needs ≥ 20 forward sessions.</Empty>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-6" title="Jobs — persistent queue">
        <div className="max-h-64 overflow-y-auto"><table><thead><tr><th>#</th><th>Kind</th><th>Status</th><th>Attempts</th><th>Started</th><th>Duration</th></tr></thead><tbody>{d.jobs.map((j: any) => <tr key={j.id} title={j.error || ""}><td className="num">{j.id}</td><td>{j.kind.replace(/_/g, " ")}</td><td><Pill v={j.status} /></td><td className="num">{j.attempts}</td><td className="text-dim">{ago(j.started)}</td><td className="num">{j.finished && j.started ? `${f(j.finished - j.started, 1)}s` : "—"}</td></tr>)}</tbody></table>{!d.jobs.length && <Empty>No jobs have run through the queue yet.</Empty>}</div>
        {d.failed_jobs.length > 0 && <div className="mt-2 text-xs text-dn">Failed: {d.failed_jobs.map((j: any) => `#${j.id} ${j.kind}`).join(", ")}</div>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-6" title="Recovery log, epochs and data issues">
        <div className="max-h-28 overflow-y-auto text-[11px]">{d.recovery_log.map((r: any) => <div key={r.id} className="py-0.5 border-b border-line/40"><span className="text-dim">{ago(r.ts)}</span> {r.message}</div>)}{!d.recovery_log.length && <div className="text-dim">No interruptions recorded.</div>}</div>
        <table className="mt-2"><thead><tr><th>Epoch</th><th>Development</th><th>Validation from</th><th>Holdout</th></tr></thead><tbody>{d.epochs.map((e: any) => <tr key={e.id}><td className="num">{e.id}</td><td className="num">{e.dev_start_day} →</td><td className="num">{e.val_start_day}</td><td className="num">{e.holdout_start_day} → {e.holdout_end_day}</td></tr>)}</tbody></table>
        <div className="max-h-24 overflow-y-auto text-[11px] mt-2">{d.data_issues.map((i: any) => <div key={i.id} className="py-0.5"><Pill v={i.severity === "error" ? "fail" : "warn"}>{i.kind.replace(/_/g, " ")}</Pill> <span className="text-dim">{i.symbol} {i.day}</span> {i.detail}</div>)}{!d.data_issues.length && <div className="text-dim">No data-quality issues recorded.</div>}</div>
      </Panel>
    </div>
  );
}

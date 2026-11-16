import React, { useState } from "react";
import { useApi, f, cad, ago } from "../api";
import { Panel, Tag, Lines, Pill, Stat, Btn, Loading, Empty, COLORS } from "../ui";
import { act } from "../App";

export default function Darwin() {
  const { data: d, error, refresh } = useApi("/api/darwin", 6000);
  const [cid, setCid] = useState<number | null>(null);
  const cur = cid ?? d?.cycles?.[0]?.id ?? null;
  const { data: c } = useApi(cur ? `/api/darwin/cycle/${cur}` : null, 8000);
  if (!d) return <Loading error={error} />;
  const fam: Record<string, number> = {};
  d.trial_counts.forEach((t: any) => (fam[t.family] = (fam[t.family] || 0) + t.n));
  const tot = Math.max(1, d.total_trials);
  const roots: any[] = d.genealogy.filter((s: any) => !s.parent_id), kids = (id: string) => d.genealogy.filter((s: any) => s.parent_id === id);
  const node = (s: any, depth = 0): any => (<div key={s.id}><div className="flex items-center gap-2 py-1 text-xs" style={{ paddingLeft: depth * 18 }}>{depth > 0 && <span className="text-dim">└</span>}
    <span className="num">{s.id}</span><Pill v={s.status} /><span className="text-dim">{s.family} · cycle {s.cycle_id ?? "—"} · epoch {s.epoch}</span><span className="truncate text-dim/80" title={s.description}>{s.description}</span></div>{kids(s.id).map((k: any) => node(k, depth + 1))}</div>);
  const imp = (m: any) => { const e = Object.entries(m.metrics.importance || {}) as [string, number][]; const mx = Math.max(1e-9, ...e.map((x) => x[1])); return e.sort((a, b) => b[1] - a[1]).slice(0, 9).map(([k, v]) => ({ k, v: v / mx })); };
  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12" title="Research budget and history" tag={<Tag kind={d.data_kind} seg={d.segment} />} right={<Btn kind="primary" onClick={() => act("/api/control/cycle", refresh)}>Run research cycle</Btn>}>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
          <Stat label="Strategies ever tested" value={d.total_trials} sub="every one is recorded as a trial" />
          <Stat label="Cycles" value={d.cycles.length} sub={`${d.cycles.filter((x: any) => x.status === "done").length} completed`} />
          <Stat label="Hypotheses" value={d.hypotheses.length} sub={`${d.hypotheses.filter((h: any) => h.status === "rejected").length} rejected`} />
          <Stat label="Population × generations" value={`${d.budget.population} × ${d.budget.generations}`} sub={`+ ${d.budget.optuna_trials} Bayesian tuning trials`} />
          <Stat label="Validation shortlist" value={d.budget.validate_top_k} sub="≤ 3 candidates reach the Skeptic" />
          <Stat label="Queue" value={d.queue.length} sub={d.queue.map((q: any) => q.kind).join(", ") || "idle"} />
        </div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-5" title="Experiment history — research cycles">
        <div className="max-h-72 overflow-y-auto"><table><thead><tr><th>#</th><th>Epoch</th><th>Status</th><th>Tested</th><th>Validated</th><th>Approved</th><th>Trigger</th></tr></thead>
          <tbody>{d.cycles.map((x: any) => (<tr key={x.id} onClick={() => setCid(x.id)} className={`cursor-pointer ${x.id === cur ? "bg-raised" : ""}`}><td className="num">{x.id}</td><td className="num">{x.epoch}</td><td><Pill v={x.status}>{x.status === "running" ? x.stage : x.status}</Pill></td>
            <td className="num">{x.summary?.trials ?? "…"}</td><td className="num">{x.summary?.validated ?? "…"}</td><td className="num text-up">{x.summary?.approved?.length ?? "…"}</td><td className="text-dim max-w-[220px] truncate" title={x.trigger}>{x.trigger}</td></tr>))}</tbody></table></div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-7" title={`Evolution — cycle ${cur ?? "—"}: development fitness by generation`} tag={<Tag kind={d.data_kind} seg="development" />}>
        {c?.generations?.length ? <><Lines height={170} zero={false} fmt={(v: number) => f(v, 2)} labels={c.generations.map((g: any) => (g.g > d.budget.generations ? "tuning" : `gen ${g.g}`))}
          series={[{ name: "best fitness", data: c.generations.map((g: any) => g.best), bold: true }, { name: "mean fitness", data: c.generations.map((g: any) => g.mean), color: "#64748b" }]} />
          <div className="text-[11px] text-dim">Fitness = ½·t(all development days) + ½·t(weakest third) − complexity charge. It rewards stability, not maximum return. {c.cycle.summary?.pbo?.pbo != null && <>Cycle PBO: <b className="num text-text">{f(c.cycle.summary.pbo.pbo, 2)}</b>.</>} {c.cycle.summary?.conclusion}</div></> : <Empty>No trials recorded for this cycle yet.</Empty>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-7" title={`Candidates — cycle ${cur ?? "—"} (top by development fitness)`} tag={<Tag kind={d.data_kind} seg="development → validation" />}>
        <div className="max-h-80 overflow-y-auto"><table><thead><tr><th>Strategy</th><th>Origin</th><th>Fitness</th><th>Dev trades</th><th>Dev net</th><th>Val net</th><th>Val p</th><th>Stage</th></tr></thead>
          <tbody>{(c?.trials || []).slice(0, 60).map((t: any) => (<tr key={t.id}><td className="max-w-[340px] truncate" title={t.description}>{t.description}</td><td className="text-dim">{t.origin} g{t.generation}</td><td className="num">{f(t.dev.fitness)}</td><td className="num">{t.dev.trades}</td>
            <td className={`num ${t.dev.net_cad >= 0 ? "text-up" : "text-dn"}`}>{cad(t.dev.net_cad)}</td><td className={`num ${t.val ? (t.val.net_cad >= 0 ? "text-up" : "text-dn") : "text-dim"}`}>{t.val ? cad(t.val.net_cad) : "—"}</td><td className="num">{t.val ? f(t.val.p, 3) : "—"}</td>
            <td><Pill v={t.stage === "validated" ? "pass" : t.stage === "val_failed" ? "fail" : "na"}>{t.stage.replace("_", " ")}</Pill></td></tr>))}</tbody></table></div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-5" title="Hypotheses generated">
        <div className="max-h-80 overflow-y-auto">{d.hypotheses.filter((h: any) => !cur || h.cycle_id === cur).map((h: any) => (<div key={h.id} className="py-1.5 border-b border-line/60 text-xs">
          <Pill v={h.status === "supported_on_validation" ? "pass" : h.status === "rejected" ? "fail" : "na"}>{h.status.replace(/_/g, " ")}</Pill> <span className="text-dim">{h.family}{h.evidence?.t != null ? ` · t=${f(h.evidence.t, 1)} · n=${h.evidence.n}` : ""}</span><div className="mt-0.5">{h.statement}</div></div>))}</div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-6" title="Model genealogy — strategy versions and lineage">{roots.length ? <div className="max-h-72 overflow-y-auto">{roots.map((r) => node(r))}</div> : <Empty>No strategies registered yet.</Empty>}</Panel>
      <Panel className="col-span-12 xl:col-span-6" title="What the search has learned (knowledge base)">
        <div className="text-[10px] text-dim uppercase mb-1">Search effort by family · success posterior (validation passes / attempts)</div>
        {Object.entries(fam).map(([k, n], i) => { const kb = d.knowledge.families.find((x: any) => x.family === k); return (<div key={k} className="flex items-center gap-2 py-0.5 text-xs"><span className="w-20">{k}</span>
          <div className="flex-1 h-2 bg-raised rounded"><div className="h-full rounded" style={{ width: `${(n / tot) * 100}%`, background: COLORS[i] }} /></div><span className="num w-12 text-right">{n}</span>
          <span className="num w-24 text-right text-dim">{kb ? `${f(kb.alpha - 1, 0)} / ${f(kb.alpha + kb.beta - 2, 0)}` : "—"}</span></div>); })}
        <div className="text-[10px] text-dim uppercase mt-3 mb-1">Lessons from failures</div>
        <div className="max-h-40 overflow-y-auto">{d.knowledge.lessons.slice(0, 20).map((l: any) => <div key={l.id} className="text-[11px] py-0.5 border-b border-line/40"><span className="text-dim">cycle {l.cycle_id} · {l.family}</span> — {l.lesson} <span className="text-dim">[{(l.elements || []).join(", ")}]</span></div>)}</div>
      </Panel>
      <Panel className="col-span-12" title="Training results — model versions and feature importance" tag={<Tag kind={d.data_kind} seg="development (training) · last 20% internal check" />}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">{d.models.map((m: any) => (<div key={m.id} className="border border-line rounded p-2">
          <div className="flex items-center gap-2"><span className="num font-medium">{m.id}</span><Pill v="na">epoch {m.epoch}</Pill><span className="text-[10px] text-dim">{ago(m.created)}</span></div>
          <div className="text-[11px] text-dim my-1">trained on sessions 0–{m.train_end} · n={m.metrics.n_train} · AUC {f(m.metrics.internal_auc, 3)} · Brier {f(m.metrics.internal_brier, 4)} vs base {f(m.metrics.internal_brier_base, 4)}</div>
          {imp(m).map((x) => <div key={x.k} className="flex items-center gap-2 text-[11px]"><span className="w-20 text-dim truncate">{x.k}</span><div className="flex-1 h-1.5 bg-raised rounded"><div className="h-full bg-vio rounded" style={{ width: `${x.v * 100}%` }} /></div></div>)}
          <div className="text-[10px] text-dim mt-1 num truncate" title={m.sha}>sha256 {m.sha.slice(0, 16)}…</div></div>))}</div>
      </Panel>
    </div>
  );
}

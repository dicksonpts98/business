import React, { useEffect, useState } from "react";
import { useApi, f, pct } from "../api";
import { Panel, Tag, Candles, Hist, Pill, Btn, Loading, Empty, evMarker, REG } from "../ui";

export default function Traps({ status }: any) {
  const qs = new URLSearchParams(location.hash.split("?")[1] || "");
  const [sym, setSym] = useState(qs.get("symbol") || "SPY"), [pat, setPat] = useState(""), [sel, setSel] = useState<number | null>(null), [reveal, setReveal] = useState(false);
  const { data: ev, error } = useApi(`/api/events?symbol=${sym}${pat ? `&pattern=${pat}` : ""}&limit=120`, 15000);
  const { data: stats } = useApi("/api/events/stats", 0);
  const { data: rp } = useApi(sel ? `/api/events/${sel}/replay` : null, 0);
  useEffect(() => { if (ev?.events?.length && (sel === null || !ev.events.find((e: any) => e.id === sel))) { setSel(ev.events[0].id); setReveal(false); } }, [ev]);
  if (!ev) return <Loading error={error} />;
  const sl = "bg-raised border border-line rounded px-2 py-1 text-xs";
  const st = stats?.stats?.find((s: any) => rp && s.pattern === rp.event.pattern);
  const idx = ev.events.findIndex((e: any) => e.id === sel);
  const step = (k: number) => { const e = ev.events[idx + k]; if (e) { setSel(e.id); setReveal(false); } };
  const known = rp?.known_at_detection || [], after = rp?.after_detection || [];
  const detTime = known.length ? known[known.length - 1].time : 0;
  const lv = rp?.levels_at_detection || {};
  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12 xl:col-span-8" title={rp ? `${rp.event.symbol} ${rp.event.day} — ${rp.event.pattern.replace(/_/g, " ")}` : "Event replay"} tag={rp && <Tag kind={rp.data_kind} seg={rp.segment} />}
        right={<div className="flex gap-1.5"><Btn onClick={() => step(1)} disabled={idx >= ev.events.length - 1}>◂ older</Btn><Btn onClick={() => step(-1)} disabled={idx <= 0}>newer ▸</Btn>
          <Btn kind="primary" onClick={() => setReveal(!reveal)}>{reveal ? "Hide what happened next" : "Reveal what happened next"}</Btn></div>}>
        {rp ? (<>
          <Candles height={330} candles={reveal ? [...known, ...after] : known} dimAfter={reveal ? detTime : undefined}
            markers={[evMarker({ ...rp.event, time: detTime }, rp.event.id), ...(reveal && rp.outcome ? [{ time: rp.outcome.entry_time, position: "inBar", color: "#22d3ee", shape: "circle", text: "earliest entry" }] : [])]}
            lines={[{ price: rp.event.level, color: "#fbbf24", title: "broken level" }, { price: rp.event.invalidation, color: "#f87171", title: "invalidation" }, { price: lv.or_high, color: "#334155", title: "OR high" }, { price: lv.or_low, color: "#334155", title: "OR low" }]} />
          <div className="text-xs text-dim mt-2">{rp.definition}. Detected at the close of the confirming bar ({new Date(rp.detected_at).toLocaleTimeString("en-CA", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false })} ET); {rp.entry_rule}.
            {!reveal && <span className="text-cy"> The chart shows only what was known at that moment.</span>}</div>
          {reveal && rp.outcome && <div className="flex gap-6 mt-2 text-xs">{[6, 12, 24].map((h) => { const v = rp.outcome[`${h}_bars_bps`]; return <span key={h}>fade return after {h} bars: <b className={`num ${v >= 0 ? "text-up" : "text-dn"}`}>{f(v, 1)} bps</b></span>; })}<span className="text-dim">(before costs; one event proves nothing)</span></div>}
        </>) : <Empty>Select an event.</Empty>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Information available at detection">
        {rp ? (<div className="text-xs">
          <div className="flex gap-2 mb-2"><Pill v={rp.event.direction > 0 ? "pass" : "fail"}>{rp.event.direction > 0 ? "fade: long" : "fade: short"}</Pill><Pill v="na">{rp.regime}</Pill><Pill v={rp.event.context.entry_eligible ? "pass" : "na"}>{rp.event.context.entry_eligible ? "entry eligible" : "no next bar"}</Pill></div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">{Object.entries(rp.event.context).filter(([, v]) => typeof v === "number").map(([k, v]: any) => <div key={k} className="flex justify-between"><span className="text-dim">{k}</span><span className="num">{f(v, 2)}</span></div>)}</div>
          <div className="mt-2 pt-2 border-t border-line grid grid-cols-2 gap-x-4 gap-y-0.5">{Object.entries(lv).map(([k, v]: any) => <div key={k} className="flex justify-between"><span className="text-dim">{k}</span><span className="num">{f(v, 2)}</span></div>)}</div>
        </div>) : <Empty>—</Empty>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-5" title="Event timeline" right={<div className="flex gap-1.5"><select className={sl} value={sym} onChange={(e) => setSym(e.target.value)}>{(status?.symbols || ["SPY", "QQQ", "NVDA", "TSLA"]).map((s: string) => <option key={s}>{s}</option>)}</select>
        <select className={sl} value={pat} onChange={(e) => setPat(e.target.value)}><option value="">all patterns</option>{Object.keys(ev.patterns).map((p) => <option key={p}>{p}</option>)}</select></div>}>
        <div className="max-h-80 overflow-y-auto"><table><thead><tr><th>Detected (UTC)</th><th>Pattern</th><th>Fade</th><th>Level</th><th>Segment</th></tr></thead>
          <tbody>{ev.events.map((e: any) => (<tr key={e.id} onClick={() => { setSel(e.id); setReveal(false); }} className={`cursor-pointer ${e.id === sel ? "bg-raised" : ""}`}><td className="num">{e.ts.slice(0, 16).replace("T", " ")}</td><td>{e.pattern.replace(/_/g, " ")}</td>
            <td className={e.direction > 0 ? "text-up" : "text-dn"}>{e.direction > 0 ? "long" : "short"}</td><td className="num">{f(e.level)}</td><td className="text-dim">{e.segment}</td></tr>))}</tbody></table></div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-7" title={`Historical pattern statistics${st ? ` — ${st.pattern.replace(/_/g, " ")}` : ""}`} tag={stats && <Tag kind={stats.data_kind} seg="development + validation" />}>
        {st && st.n > 0 && st.horizons ? (<>
          <div className="grid grid-cols-2 gap-4">
            <div><div className="text-[10px] text-dim uppercase mb-1">Fade return, 12 bars from next open (bps) · n={st.n}</div><Hist counts={st.hist || []} lo={-150} hi={150} mark={0} /></div>
            <div className="text-xs overflow-x-auto"><table><thead><tr><th>Entry / horizon</th><th>n</th><th>Mean</th><th>95% CI</th><th>Hit</th><th>Net</th><th>Net 3× cost</th></tr></thead>
              <tbody>{Object.entries(st.horizons).map(([k, v]: any) => (<tr key={k}><td>{k.replace("next_open", "next open").replace("confirmed", "confirmed").replace(":", " · ")} bars</td><td className="num">{v.n}</td><td className={`num ${v.mean_bps >= 0 ? "text-up" : "text-dn"}`}>{f(v.mean_bps, 1)}</td>
                <td className="num text-dim">[{f(v.ci95[0], 1)}, {f(v.ci95[1], 1)}]</td><td className="num">{pct(v.hit_rate)}</td><td className={`num ${v.net_base_bps >= 0 ? "text-up" : "text-dn"}`}>{f(v.net_base_bps, 1)}</td><td className={`num ${v.net_stress_bps >= 0 ? "text-up" : "text-dn"}`}>{f(v.net_stress_bps, 1)}</td></tr>))}</tbody></table></div>
          </div>
          <div className="flex gap-6 mt-2 text-[11px] text-dim">{Object.entries(st.by_regime || {}).map(([k, v]: any) => <span key={k}>{REG[+k]}: n={v.n}, mean <b className="num text-text">{f(v.mean_bps, 1)}</b> bps [{f(v.ci95[0], 0)}, {f(v.ci95[1], 0)}]</span>)}</div>
          <div className="text-[10px] text-dim mt-1">{stats.note} Intervals are bootstrapped by session. A confidence interval that spans zero means the pattern has shown no reliable tendency.</div>
        </>) : <Empty>{stats ? "No statistics for this pattern in the research window." : "computing…"}</Empty>}
        {stats && <div className="mt-3 pt-3 border-t border-line max-h-48 overflow-y-auto"><table><thead><tr><th>All patterns</th><th>n</th><th>Mean bps (next open · 12 bars)</th><th>95% CI</th><th>Net</th></tr></thead>
          <tbody>{stats.stats.filter((s: any) => s.n > 0 && s.horizons?.["next_open:12"]).map((s: any) => { const h = s.horizons["next_open:12"]; const sig = h.ci95[0] > 0 || h.ci95[1] < 0; return (
            <tr key={s.pattern} className="cursor-pointer" onClick={() => setPat(s.pattern)}><td>{s.pattern.replace(/_/g, " ")}</td><td className="num">{s.n}</td><td className={`num ${sig ? (h.mean_bps > 0 ? "text-up" : "text-dn") : "text-dim"}`}>{f(h.mean_bps, 1)}</td><td className="num text-dim">[{f(h.ci95[0], 1)}, {f(h.ci95[1], 1)}]</td><td className="num">{f(h.net_base_bps, 1)}</td></tr>); })}</tbody></table></div>}
      </Panel>
    </div>
  );
}

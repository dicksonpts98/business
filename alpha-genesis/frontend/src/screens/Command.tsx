import React from "react";
import { useApi, f, cad, tone, ago } from "../api";
import { Panel, Stat, Pill, Tag, Lines, Spark, Meter, Btn, Loading, Empty, REG, REGC } from "../ui";
import { act } from "../App";

export default function Command() {
  const { data: d, error, refresh } = useApi("/api/command", 4000);
  if (!d) return <Loading error={error} />;
  const p = d.portfolio, eq = p.curve, L = d.risk.limits, ls = d.risk.last_session;
  const ret = ((p.equity_cad / p.start_cad) - 1) * 100;
  const cyc = d.research.active_cycle, last = d.research.last_cycles?.[0];
  const stages = ["observe", "evolve", "tune", "validate", "skeptic", "finalize"];
  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12" title="System">
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-4">
          <Stat label="Mode" value={<span className="text-warn">PAPER</span>} sub={d.broker.name} />
          <Stat label="Paper state" value={d.champion ? <span className="text-cy">TRADING</span> : <span className="text-dim">IDLE</span>} sub={d.paper_state} />
          <Stat label="Paper equity" value={cad(p.equity_cad, 2)} sub={<span className={tone(ret)}>{ret >= 0 ? "+" : ""}{f(ret, 2)}% since start</span>} />
          <Stat label="Last session P&L" value={<span className={tone(p.last_pnl_cad)}>{cad(p.last_pnl_cad, 2)}</span>} sub={d.market.session} />
          <Stat label="Market regime" value={<span style={{ color: REGC[REG.indexOf(d.market.regime)] }}>{d.market.regime}</span>} sub={`20-day trend ${d.market.trend > 0 ? "up" : "down"}`} />
          <Stat label="Strategies" value={`${(d.counts.CHAMPION || 0) + (d.counts.SHADOW || 0)} live`} sub={`${d.counts.REJECTED || 0} rejected · ${d.counts.BASELINE || 0} baselines`} />
          <Stat label="Holdout looks" value={`${d.epoch.holdout_uses}/${d.epoch.holdout_budget}`} sub={`epoch ${d.epoch.id} · ${d.epoch.forward_sessions} forward sessions`} />
          <Stat label="Audit chain" value={d.audit.chain_ok ? <span className="text-up">INTACT</span> : <span className="text-dn">BROKEN</span>} sub={`${d.audit.entries} entries`} />
        </div>
        <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-line items-center">
          <span className="text-[11px] text-dim mr-1">Operator:</span>
          <Btn kind="primary" onClick={() => act("/api/control/advance?n=1", refresh)} disabled={!d.next_session}>Ingest next session</Btn>
          <Btn onClick={() => act("/api/control/advance?n=5", refresh)} disabled={!d.next_session}>+5 sessions</Btn>
          <Btn onClick={() => act("/api/control/advance?n=20", refresh)} disabled={!d.next_session}>+20 sessions</Btn>
          <Btn onClick={() => act("/api/control/cycle", refresh)}>Run research cycle</Btn>
          <div className="flex-1" />
          <span className="text-[11px] text-dim">{d.next_session ? `next session in feed: ${d.next_session}` : "feed exhausted — no further sessions available"}</span>
          {d.kill_switch.on ? <Btn kind="primary" onClick={() => act("/api/control/kill?on=false&reason=released", refresh)}>Release kill switch</Btn>
            : <Btn kind="danger" onClick={() => confirm("Engage the kill switch? All new paper entries stop and open positions are flattened.") && act("/api/control/kill?on=true&reason=operator", refresh)}>KILL SWITCH</Btn>}
        </div>
      </Panel>

      {!d.champion && d.research.last_cycles?.some((c: any) => c.status === "done") && !(d.counts.SHADOW > 0) && (
        <div className="col-span-12 border border-warn/40 bg-warn/5 rounded-lg px-4 py-2.5 text-sm"><b className="text-warn tracking-wide">NO VALID EDGE FOUND</b>
          <span className="text-dim"> — {d.research.last_cycles.filter((c: any) => c.status === "done").length} recent research cycle(s) completed on {d.data_label} data; no strategy passed independent validation. The system is in no-trade mode.</span></div>)}
      <Panel className="col-span-12 xl:col-span-7" title="Portfolio simulation — paper equity (CAD)" tag={<Tag kind={d.data_kind} seg="paper trading" />}>
        {eq.length > 1 ? <Lines series={[{ name: "equity", data: eq.map((e: any) => e.equity), bold: true }, { name: "start", data: eq.map(() => p.start_cad), color: "#475569", dash: true }]} labels={eq.map((e: any) => e.day)} zero={false} height={210} />
          : <Empty>No paper sessions yet. Paper trading begins only after a strategy passes independent validation and a shadow period.</Empty>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-5" title="Risk utilisation — last session" tag={<Tag seg="risk guardian" />}>
        <div className="space-y-3">
          <Meter label="Daily loss used (CAD)" v={Math.max(0, -(p.last_pnl_cad || 0))} max={L.max_daily_loss_cad} />
          <Meter label="Entries used" v={ls?.entries || 0} max={L.max_entries_per_day} color="#a78bfa" />
          <div className="grid grid-cols-3 gap-3 pt-1">
            <Stat label="Risk / trade" value={cad(L.risk_per_trade_cad)} sub="planned, not guaranteed" />
            <Stat label="Max positions" value={L.max_positions} sub={`exposure ≤ ${L.max_total_exposure_x}× equity`} />
            <Stat label="Guardian rejects" value={ls?.rejects ?? 0} sub={ls ? `paper vs research Δ ${cad(ls.discrepancy_cad ?? 0, 2)}` : "—"} />
          </div>
        </div>
      </Panel>

      <Panel className="col-span-12 xl:col-span-7" title="Market conditions" tag={<Tag kind={d.data_kind} seg={d.market.session} />}>
        <table><thead><tr><th>Instrument</th><th>Close</th><th>Session</th><th>Ann. vol</th><th>Pattern events</th><th>Intraday</th></tr></thead>
          <tbody>{d.market.instruments.map((i: any) => (
            <tr key={i.symbol}><td className="font-medium">{i.symbol}</td><td className="num">{f(i.close)}</td><td className={`num ${tone(i.day_return_pct)}`}>{i.day_return_pct >= 0 ? "+" : ""}{f(i.day_return_pct)}%</td>
              <td className="num">{f(i.ann_vol_pct, 1)}%</td><td className="num">{i.events_today}</td><td><Spark data={i.spark} color={i.day_return_pct >= 0 ? "#34d399" : "#f87171"} /></td></tr>))}</tbody></table>
      </Panel>
      <Panel className="col-span-12 xl:col-span-5" title="Active research">
        {cyc ? (
          <div>
            <div className="flex items-center gap-2 mb-2"><Pill v="running">cycle {cyc.id}</Pill><span className="text-dim text-xs truncate">{cyc.trigger}</span></div>
            <div className="flex gap-1">{stages.map((s) => { const i = stages.indexOf(s), c = stages.indexOf(cyc.stage); return <div key={s} className="flex-1"><div className={`h-1 rounded ${i < c ? "bg-up" : i === c ? "bg-cy pulse" : "bg-raised"}`} /><div className={`text-[10px] mt-1 ${i === c ? "text-cy" : "text-dim"}`}>{s}</div></div>; })}</div>
          </div>
        ) : <div className="text-dim text-xs mb-2">No research cycle is running. {d.worker.queued} job(s) queued.</div>}
        {last?.summary && <div className="mt-3 pt-3 border-t border-line text-xs space-y-1">
          <div className="text-dim">Last completed cycle #{last.id} · {ago(last.finished)}</div>
          <div><span className="num">{last.summary.trials}</span> strategies tested → <span className="num">{last.summary.shortlisted}</span> shortlisted → <span className="num">{last.summary.validated}</span> passed validation → <span className="num text-up">{last.summary.approved.length}</span> approved</div>
          <div className="text-dim italic">{last.summary.conclusion}</div>
        </div>}
      </Panel>

      <Panel className="col-span-12 xl:col-span-4" title="Recent discoveries (hypotheses tested)">
        {d.discoveries.length ? d.discoveries.map((h: any) => (
          <div key={h.id} className="py-1.5 border-b border-line/60 last:border-0 text-xs"><Pill v={h.status === "rejected" ? "fail" : "pass"}>{h.status === "rejected" ? "rejected" : "supported"}</Pill> <span className="text-dim">#{h.cycle_id}</span><div className="mt-0.5">{h.statement}</div></div>
        )) : <Empty>No hypotheses tested yet.</Empty>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Promotions, demotions, rollbacks">
        {d.promotions.length ? d.promotions.map((r: any) => (
          <div key={r.id} className="py-1.5 border-b border-line/60 last:border-0 text-xs"><span className="num text-dim">{r.strategy_id}</span> <Pill v={r.from_status} /> → <Pill v={r.to_status} /><div className="text-dim mt-0.5 truncate" title={r.reason}>{r.reason}</div></div>
        )) : <Empty>No lifecycle events yet.</Empty>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Alerts" right={d.alerts.length ? <Btn onClick={() => act("/api/alerts/ack", refresh)}>Acknowledge</Btn> : null}>
        {d.alerts.length ? d.alerts.map((a: any) => (<div key={a.id} className="py-1.5 border-b border-line/60 last:border-0 text-xs"><Pill v={a.level} /> <span className="text-dim">{a.source} · {ago(a.ts)}</span><div className="mt-0.5">{a.message}</div></div>)) : <Empty>No unacknowledged alerts.</Empty>}
      </Panel>
    </div>
  );
}

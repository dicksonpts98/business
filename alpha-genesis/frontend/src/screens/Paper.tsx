import React, { useState } from "react";
import { useApi, f, cad, pct, ago, post } from "../api";
import { Panel, Tag, Lines, Pill, Stat, Meter, Btn, Loading, Empty, REG } from "../ui";

export default function Paper() {
  const { data: d, error } = useApi("/api/paper", 5000);
  const [open, setOpen] = useState<number | null>(null);
  const { data: br, refresh: brRefresh } = useApi("/api/broker", 15000);
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false);
  const runDiag = async () => { setBusy(true); try { await post("/api/broker/diagnostic?confirm=PAPER-DIAGNOSTIC"); } catch (e: any) { alert(e.message); } setBusy(false); setConfirming(false); brRefresh(); };
  if (!d) return <Loading error={error} />;
  const L = d.limits, s = d.summary, eq = d.equity, last = d.sessions[0]?.payload;
  const unreal = 0;
  return (
    <div className="grid grid-cols-12 gap-3">
      <Panel className="col-span-12" title="Paper account" tag={<Tag kind={d.data_kind} seg="paper trading" />} right={<span className="text-[11px] text-warn">{d.mode}</span>}>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-4">
          <Stat label="Equity" value={cad(eq.length ? eq[eq.length - 1].equity_cad : L.starting_capital_cad, 2)} sub={`start ${cad(L.starting_capital_cad)}`} />
          <Stat label="Realised P&L" value={<span className={s.net >= 0 ? "text-up" : "text-dn"}>{cad(s.net || 0, 2)}</span>} sub={`gross ${cad(s.gross || 0)} − costs ${cad(s.cost || 0)}`} />
          <Stat label="Unrealised P&L" value={cad(unreal, 2)} sub={`${d.positions.length} open position(s)`} />
          <Stat label="Trades" value={s.n} sub={s.n ? `win rate ${pct(s.wins / s.n)}` : "—"} /><Stat label="Expectancy" value={`${f(s.r, 3)} R`} sub="net of all costs" />
          <Stat label="Exposure now" value={cad(d.exposure_cad)} sub={`limit ${L.max_total_exposure_x}× equity`} /><Stat label="Sessions traded" value={eq.filter((e: any) => e.strategy_id).length} sub={`${eq.length} processed`} />
          <Stat label="Guardian" value={d.halt ? <span className="text-dn">HALTED</span> : <span className="text-up">ARMED</span>} sub={d.halt || `limits sha ${d.limits_sha.slice(0, 8)}…`} />
        </div>
      </Panel>
      <Panel className="col-span-12" title="Alpaca paper account — synchronisation and diagnostic" tag={<Tag seg="paper-api.alpaca.markets" />}
        right={br && <Pill v={br.reachable ? "pass" : "warn"}>{br.reachable ? "connected" : "not connected"}</Pill>}>
        {br ? (<div className="grid grid-cols-12 gap-4 text-xs">
          <div className="col-span-12 xl:col-span-4 space-y-1">
            <div>Mode: <b className={br.paper_mode === "experimental" ? "text-warn" : "text-cy"}>{br.paper_mode === "experimental" ? "EXPERIMENTAL paper trading" : "VALIDATED autonomous paper trading"}</b></div>
            <div className="text-dim">{br.paper_mode === "experimental"
              ? `With no champion, the best Skeptic-approved shadow strategy may trade at ${cad(br.experimental_limits.risk_per_trade_cad, 2)} risk/trade, ≤ ${br.experimental_limits.max_entries_per_day} entries/day, ≤ ${cad(br.experimental_limits.max_daily_loss_cad)} daily loss. Currently: ${br.experimental_deployment || "no approved strategy — no orders"}.`
              : "Only a promoted champion trades, at the full Risk Guardian limits. Switch modes in config/risk.toml (operator only)."}</div>
            <div className="text-dim">Order mirroring to Alpaca paper: {br.mirror_enabled ? "on (live sessions only)" : "off — the internal paper broker executes; enable with [broker] mirror = \"alpaca_paper\""}. Live trading: {br.live_trading}.</div>
          </div>
          <div className="col-span-12 xl:col-span-4">
            {br.reachable ? (<div className="grid grid-cols-2 gap-x-4 gap-y-0.5">{Object.entries(br.account).filter(([, v]) => v !== null).map(([k, v]: any) => <div key={k} className="flex justify-between"><span className="text-dim">{k.replace(/_/g, " ")}</span><span className="num">{String(v)}</span></div>)}
              <div className="col-span-2 mt-1">Positions in sync with internal book: <Pill v={br.in_sync ? "pass" : "fail"}>{br.in_sync ? "yes" : "NO"}</Pill> · {Object.keys(br.positions).length} broker position(s) · {br.orders.length} recent order(s)</div></div>)
              : <div className="text-warn">The paper account cannot be reached from this machine: {br.error}. Add APCA_API_KEY_ID / APCA_API_SECRET_KEY for the paper account (see docs/OPERATIONS.md).</div>}
          </div>
          <div className="col-span-12 xl:col-span-4">
            {!confirming ? <Btn kind="primary" onClick={() => setConfirming(true)}>Run diagnostic paper order…</Btn> : (
              <div className="border border-warn/50 rounded p-2 bg-warn/5"><div className="mb-2"><b>Confirm:</b> submit ONE paper order to Alpaca — buy 1 {"share"} of the market proxy as a limit order at $1.00 (it cannot fill), read it back, then cancel it. No real money is involved.</div>
                <div className="flex gap-2"><Btn kind="danger" disabled={busy} onClick={runDiag}>{busy ? "running…" : "Yes, send the paper diagnostic"}</Btn><Btn onClick={() => setConfirming(false)}>Cancel</Btn></div></div>)}
            {br.last_diagnostic && <div className="mt-2"><Pill v={br.last_diagnostic.ok ? "pass" : "fail"}>{br.last_diagnostic.ok ? "last diagnostic passed" : "last diagnostic failed"}</Pill> <span className="text-dim">{ago(br.last_diagnostic.ts)}</span>
              {br.last_diagnostic.error && <div className="text-dn mt-1">{br.last_diagnostic.error}</div>}
              {(br.last_diagnostic.steps || []).map((s: any) => <div key={s.step} className="flex gap-2 mt-0.5"><Pill v={s.ok ? "pass" : "fail"}>{s.step.replace(/_/g, " ")}</Pill><span className="text-dim truncate">{JSON.stringify(s.detail).slice(0, 90)}</span></div>)}</div>}
          </div>
        </div>) : <Empty>checking broker…</Empty>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-8" title="Equity and session P&L (CAD)" tag={<Tag kind={d.data_kind} seg="paper trading" />}>
        {eq.length > 1 ? <Lines height={220} zero={false} labels={eq.map((e: any) => e.day)} series={[{ name: "equity", data: eq.map((e: any) => e.equity_cad), bold: true }]} fmt={(v: number) => cad(v)} /> : <Empty>No paper sessions processed yet.</Empty>}
        {eq.length > 1 && <div className="flex items-end gap-px h-12 mt-1">{eq.slice(-150).map((e: any) => { const mx = Math.max(1, ...eq.map((x: any) => Math.abs(x.pnl_cad))); return <div key={e.day} title={`${e.day}: ${cad(e.pnl_cad, 2)} (${e.strategy_id || "not trading"})`} className="flex-1" style={{ height: `${Math.max(2, (Math.abs(e.pnl_cad) / mx) * 100)}%`, background: e.pnl_cad > 0 ? "#34d399" : e.pnl_cad < 0 ? "#f87171" : "#1c2636" }} />; })}</div>}
      </Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Risk limits (Risk Guardian — not writable by research)">
        <div className="space-y-2.5">
          <Meter label="Daily loss (CAD) — last session" v={Math.max(0, -(last?.pnl_cad || 0))} max={L.max_daily_loss_cad} />
          <Meter label="Entries — last session" v={last?.entries || 0} max={L.max_entries_per_day} color="#a78bfa" />
          <Meter label="Open positions" v={d.positions.length} max={L.max_positions} color="#34d399" />
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] pt-1">{Object.entries(L).map(([k, v]: any) => <div key={k} className="flex justify-between"><span className="text-dim">{k.replace(/_/g, " ")}</span><span className="num">{String(v)}</span></div>)}</div>
          <div className="text-[10px] text-dim">A planned loss is not a guaranteed maximum: gaps and slippage can exceed it.</div>
        </div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-4" title="Active simulated positions">
        {d.positions.length ? <table><thead><tr><th>Sym</th><th>Side</th><th>Qty</th><th>Entry</th><th>Stop</th></tr></thead><tbody>{d.positions.map((p: any) => <tr key={p.symbol}><td>{p.symbol}</td><td className={p.side > 0 ? "text-up" : "text-dn"}>{p.side > 0 ? "long" : "short"}</td><td className="num">{p.qty}</td><td className="num">{f(p.entry_px)}</td><td className="num">{f(p.stop_px)}</td></tr>)}</tbody></table>
          : <Empty>Flat. Positions are intraday only and are closed by the end of each session.</Empty>}
        <div className="text-[10px] text-dim uppercase mt-3 mb-1">Why losing trades lost (post-mortem attribution)</div>
        {Object.keys(d.loss_attribution).length ? Object.entries(d.loss_attribution).sort((a: any, b: any) => b[1] - a[1]).map(([k, n]: any) => { const tot = Object.values(d.loss_attribution).reduce((a: any, b: any) => a + b, 0) as number; return (
          <div key={k} className="flex items-center gap-2 text-xs py-0.5"><span className="w-40">{k.replace(/_/g, " ")}</span><div className="flex-1 h-1.5 bg-raised rounded"><div className="h-full rounded bg-warn" style={{ width: `${(n / tot) * 100}%` }} /></div><span className="num w-8 text-right">{n}</span></div>); }) : <Empty>No losing trades yet.</Empty>}
        <div className="text-[10px] text-dim mt-1">Most losses are ordinary variance. Attribution accumulates evidence; it never triggers retraining by itself.</div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-8" title="Trades — click a row for the explanation" tag={<Tag kind={d.data_kind} seg="paper trading" />}>
        <div className="max-h-80 overflow-y-auto"><table><thead><tr><th>Day</th><th>Sym</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Out</th><th>Regime</th><th>Net</th><th>R</th><th>Cost</th><th>Strategy</th></tr></thead>
          <tbody>{d.trades.map((t: any) => (<React.Fragment key={t.id}><tr className="cursor-pointer" onClick={() => setOpen(open === t.id ? null : t.id)}><td className="num">{t.day}</td><td>{t.symbol}</td><td className={t.side > 0 ? "text-up" : "text-dn"}>{t.side > 0 ? "long" : "short"}</td><td className="num">{t.qty}</td>
            <td className="num">{f(t.entry_px)}</td><td className="num">{f(t.exit_px)}</td><td className="text-dim">{t.exit_reason}</td><td className="text-dim">{REG[t.regime]}</td><td className={`num ${t.net_cad >= 0 ? "text-up" : "text-dn"}`}>{cad(t.net_cad, 2)}</td><td className="num">{f(t.r_multiple)}</td><td className="num text-dim">{cad(t.cost_cad, 2)}</td><td className="num text-dim">{t.strategy_id}</td></tr>
            {open === t.id && t.explanation && <tr><td colSpan={12} className="whitespace-normal bg-raised/60 text-xs"><div><b>Rule:</b> {t.explanation.rule}</div><div><b>Why now:</b> {t.explanation.why.join("; ")} ({t.explanation.regime} regime)</div>
              <div><b>Sizing:</b> risk budget {cad(t.explanation.sizing.risk_budget_cad)} ÷ (stop distance ${f(t.explanation.sizing.stop_distance_usd, 3)} × USD/CAD {f(t.explanation.sizing.usdcad, 4)}) = {t.explanation.sizing.risk_sized_qty} sh → approved {t.explanation.sizing.approved_qty} sh ({t.explanation.sizing.note}); planned risk {cad(t.explanation.sizing.planned_risk_cad, 2)}</div>
              {t.attribution && <div className="text-warn"><b>Loss post-mortem:</b> {t.attribution.causes.map((c: any) => `${c.cause.replace(/_/g, " ")} — ${c.detail}`).join(" · ")}</div>}</td></tr>}</React.Fragment>))}</tbody></table>{!d.trades.length && <Empty>No paper trades yet.</Empty>}</div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-6" title="Order history">
        <div className="max-h-64 overflow-y-auto"><table><thead><tr><th>Client order id</th><th>Kind</th><th>Side</th><th>Qty</th><th>Filled</th><th>Avg px</th><th>Status</th></tr></thead>
          <tbody>{d.orders.map((o: any) => <tr key={o.id}><td className="num text-[11px]">{o.client_id}</td><td>{o.kind}</td><td className={o.side > 0 ? "text-up" : "text-dn"}>{o.side > 0 ? "buy" : "sell"}</td><td className="num">{o.qty}</td><td className="num">{o.filled_qty}</td><td className="num">{f(o.avg_px)}</td><td><Pill v={o.status} /></td></tr>)}</tbody></table>{!d.orders.length && <Empty>No orders.</Empty>}</div>
      </Panel>
      <Panel className="col-span-12 xl:col-span-6" title="Paper execution log (immutable audit trail)">
        <div className="max-h-64 overflow-y-auto text-[11px]">{d.log.map((l: any) => (<div key={l.id} className="py-0.5 border-b border-line/40 flex gap-2"><span className="text-dim w-14 shrink-0">{ago(l.ts)}</span><span className={`w-36 shrink-0 ${l.action.includes("reject") || l.action.includes("kill") || l.action.includes("mismatch") ? "text-warn" : "text-cy"}`}>{l.action}</span><span className="truncate text-dim" title={JSON.stringify(l.detail)}>{l.detail.reason || l.detail.client_id || JSON.stringify(l.detail)}</span></div>))}{!d.log.length && <Empty>No execution events yet.</Empty>}</div>
      </Panel>
    </div>
  );
}

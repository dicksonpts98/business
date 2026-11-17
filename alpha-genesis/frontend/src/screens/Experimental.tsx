import React from "react";
import { f, cad } from "../api";
import { Panel, Tag, Pill, Stat, Btn, Empty } from "../ui";

/** EXPERIMENTAL live paper trading panel: switch with in-app confirmation, limits, strategies, decisions, trades. */
export default function Experimental({ ex, arming, setArming, setSwitch, closeAll }: any) {
  if (!ex) return <Panel className="col-span-12"><Empty>loading…</Empty></Panel>;
  const lim = ex.limits;
  const tick = ex.last_tick;
  return (
    <Panel className="col-span-12" title="EXPERIMENTAL live paper trading — forward test of unvalidated strategies" tag={<Tag seg="experimental · not validated" />}
      right={<Pill v={ex.suspended ? "fail" : ex.switch ? "warn" : "na"}>{ex.suspended ? "suspended" : ex.switch ? "switch ON" : "switch off"}</Pill>}>
      <div className="grid grid-cols-12 gap-4 text-xs">
        <div className="col-span-12 xl:col-span-4 space-y-1.5">
          <div className="text-warn">{ex.label}.</div>
          <div className="text-dim">Limits (Risk Guardian): position ≤ {cad(lim.max_position_cad)} · {lim.max_entries_per_day} entries per day · daily loss ≤ {cad(lim.max_daily_loss_cad)} · no leverage · flat {lim.flatten_minutes_before_close} minutes before the close, never overnight.</div>
          {ex.suspended && <div className="text-dn">Suspended: {ex.suspended}</div>}
          {!ex.live_data_provider && <div className="text-dim">Live signals need the Alpaca data provider; this instance runs on {ex.data_kind} data, so the live loop is not running.</div>}
          <div>Live loop: <b>{ex.loop_running ? "running" : "not running"}</b> · feed: <b>{ex.feed || "—"}</b>
            {ex.feed_restriction ? <span className="text-dim"> ({ex.feed_restriction.feed} refused: {String(ex.feed_restriction.error).slice(0, 60)})</span> : null}</div>
          <div className="text-dim">Last check: {tick ? tick.ts + " · " + tick.phase + (tick.data_age_s != null ? " · newest bar " + tick.data_age_s + "s old" : "") + (tick.error ? " · " + tick.error : "") : "—"}</div>
          {!ex.switch ? (!arming
            ? <Btn kind="primary" disabled={!ex.diagnostic_passed} title={ex.diagnostic_passed ? "" : "Pass the broker diagnostic first"} onClick={() => setArming(true)}>Enable experimental paper trading…</Btn>
            : (<div className="border border-warn/50 rounded p-2 bg-warn/5">
                <div className="mb-2"><b>Confirm:</b> the app will send PAPER orders to Alpaca automatically during market hours for the {ex.strategies.length} strategies listed, within the limits shown. None of them has passed validation; expect losses. No real money is involved.</div>
                <div className="flex gap-2"><Btn kind="danger" onClick={() => setSwitch(true)}>Yes, enable</Btn><Btn onClick={() => setArming(false)}>Cancel</Btn></div>
              </div>))
            : <div className="flex gap-2"><Btn kind="danger" onClick={() => setSwitch(false)}>Turn switch off</Btn><Btn onClick={closeAll}>Close all experimental positions</Btn></div>}
          {!ex.diagnostic_passed && <div className="text-dim">The switch unlocks after the broker diagnostic above has passed.</div>}
        </div>
        <div className="col-span-12 xl:col-span-4">
          <div className="text-[10px] text-dim uppercase mb-1">Strategies under forward test</div>
          {ex.strategies.map((s: any) => {
            const r = ex.by_strategy.find((x: any) => x.strategy === s.id);
            return (<div key={s.id} className="py-1 border-b border-line/50"><span className="num font-medium">{s.id}</span> <span className="text-dim">{s.source}</span>
              <div className="text-dim">{s.rule}</div>
              <div>{r ? <span>{r.n} trades · <span className={r.pnl_cad >= 0 ? "text-up" : "text-dn"}>{cad(r.pnl_cad, 2)}</span> · mean {f(r.r)}R</span> : <span className="text-dim">no trades yet</span>}</div></div>);
          })}
          {ex.ineligible.map((s: any) => <div key={s.id} className="py-1 text-dim">{s.id}: not eligible — {s.reason}</div>)}
        </div>
        <div className="col-span-12 xl:col-span-4">
          <div className="grid grid-cols-3 gap-2 mb-2">
            <Stat label="Trades" value={ex.summary.n} sub={ex.entries_today + "/" + lim.max_entries_per_day + " entries today"} />
            <Stat label="Net P&L" value={<span className={ex.summary.pnl_cad >= 0 ? "text-up" : "text-dn"}>{cad(ex.summary.pnl_cad, 2)}</span>} sub={"est. fees $" + f(ex.summary.fees)} />
            <Stat label="Mean R" value={f(ex.summary.r)} sub={ex.positions.length + " open"} />
          </div>
          <div className="text-[10px] text-dim uppercase mb-1">Decisions (signals, risk rejections, orders)</div>
          <div className="max-h-32 overflow-y-auto">
            {ex.decisions.length ? ex.decisions.map((x: any) => (
              <div key={x.id} className="py-0.5 border-b border-line/40"><span className="text-dim num">{x.ts.slice(5, 16)}</span> <span className={x.decision.includes("reject") || x.decision.includes("suspend") ? "text-warn" : "text-cy"}>{x.decision.replace(/_/g, " ")}</span> {x.strategy} {x.symbol} <span className="text-dim">{x.detail}</span></div>))
              : <span className="text-dim">No signals have been evaluated yet. Nothing is traded unless a strategy's rule fires.</span>}
          </div>
        </div>
        {ex.trades.length > 0 && (
          <div className="col-span-12 max-h-40 overflow-y-auto"><table><thead><tr><th>Day</th><th>Strategy</th><th>Sym</th><th>Side</th><th>Qty</th><th>Signal</th><th>Entry</th><th>Exit</th><th>Out</th><th>P&L USD</th><th>P&L CAD</th><th>R</th><th>Feed</th></tr></thead>
            <tbody>{ex.trades.map((t: any) => (<tr key={t.id}><td className="num">{t.day}</td><td className="num">{t.strategy}</td><td>{t.symbol}</td><td className={t.side > 0 ? "text-up" : "text-dn"}>{t.side > 0 ? "long" : "short"}</td><td className="num">{t.qty}</td>
              <td className="num text-dim">{(t.signal_ts || "").slice(11, 16)}</td><td className="num">{f(t.entry_px)}</td><td className="num">{f(t.exit_px)}</td><td className="text-dim">{t.exit_reason}</td>
              <td className={"num " + (t.pnl_usd >= 0 ? "text-up" : "text-dn")}>{f(t.pnl_usd)}</td><td className="num">{f(t.pnl_cad)}</td><td className="num">{f(t.r_multiple)}</td><td className="text-dim">{t.feed}</td></tr>))}</tbody></table></div>)}
      </div>
    </Panel>
  );
}

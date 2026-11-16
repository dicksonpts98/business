import React from "react";
import { useApi, f } from "../api";
import { Panel, Tag, Candles, Lines, Loading, evMarker, REG, REGC } from "../ui";

export default function Radar() {
  const { data: d, error } = useApi("/api/market/radar", 8000);
  if (!d) return <Loading error={error} />;
  return (
    <div className="space-y-3">
      <Panel title="Market regime — last 120 sessions" tag={<Tag kind={d.data_kind} seg={d.segment} />}>
        <div className="flex gap-px h-6">{d.regime_history.map((r: number, i: number) => <div key={i} className="flex-1 rounded-sm" title={REG[r]} style={{ background: REGC[r], opacity: 0.8 }} />)}</div>
        <div className="flex gap-4 mt-2 text-[11px] text-dim items-center">{REG.map((r, i) => <span key={r}><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ background: REGC[i] }} />{r}</span>)}<span className="flex-1" />
          <span>Current: <b style={{ color: REGC[REG.indexOf(d.regime)] }}>{d.regime}</b> · {d.regime_definition}</span></div>
      </Panel>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {d.instruments.map((i: any) => (
          <Panel key={i.symbol} title={`${i.symbol} — 5-minute bars, last two sessions`} tag={<Tag kind={d.data_kind} seg={d.segment} />}
            right={<a className="text-[11px] text-cy hover:underline" href={`#/traps?symbol=${i.symbol}`}>{i.events.length} events →</a>}>
            <Candles candles={i.candles} height={250} markers={i.events.map((e: any) => ({ ...evMarker({ ...e, time: i.candles.find((c: any) => c.d === e.d && c.bar === e.bar)?.time }), text: "" })).filter((m: any) => m.time)} />
            <div className="grid grid-cols-4 gap-x-4 gap-y-1 mt-2 text-[11px]">
              {Object.entries(i.state).map(([k, v]: any) => (<div key={k} className="flex justify-between"><span className="text-dim">{k}</span><span className={`num ${Math.abs(v) > 2 ? "text-warn" : ""}`}>{f(v)}</span></div>))}
            </div>
            <div className="mt-2"><div className="text-[10px] text-dim uppercase tracking-wider mb-1">Realised volatility (annualised %, per session, 60 sessions) — purple line on the chart is session VWAP</div>
              <Lines series={[{ name: "realised vol %", data: i.vol_history_pct, color: "#fb923c" }]} height={70} zero={false} fmt={(v: number) => f(v, 0)} /></div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

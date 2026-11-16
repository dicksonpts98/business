import React, { useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, CrosshairMode } from "lightweight-charts";
import { f } from "./api";

export const COLORS = ["#22d3ee", "#a78bfa", "#34d399", "#fbbf24", "#f87171", "#60a5fa", "#f472b6", "#94a3b8", "#fb923c", "#4ade80", "#e879f9", "#38bdf8"];

export function Panel({ title, right, children, className = "", tag }: any) {
  return (
    <section className={`bg-panel border border-line rounded-lg flex flex-col min-w-0 ${className}`}>
      {(title || right || tag) && (
        <header className="flex items-center gap-2 px-3 py-2 border-b border-line">
          <h3 className="text-[11px] uppercase tracking-wider text-dim font-medium flex-1 truncate">{title}</h3>
          {tag}{right}
        </header>
      )}
      <div className="p-3 min-w-0 flex-1">{children}</div>
    </section>
  );
}

/** Every chart and table says what kind of data it shows. */
export function Tag({ kind, seg }: { kind?: string; seg?: string }) {
  const syn = kind === "synthetic";
  return (
    <span className="flex items-center gap-1 shrink-0">
      {kind && <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide border ${syn ? "border-warn/50 text-warn bg-warn/10" : "border-up/50 text-up bg-up/10"}`}>{syn ? "SYNTHETIC" : "HISTORICAL"}</span>}
      {seg && <span className="px-1.5 py-0.5 rounded text-[10px] border border-line text-dim uppercase tracking-wide">{seg}</span>}
    </span>
  );
}

export function Stat({ label, value, sub, cls = "" }: any) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-dim truncate">{label}</div>
      <div className={`num text-lg leading-tight ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-dim truncate">{sub}</div>}
    </div>
  );
}

const PILL: Record<string, string> = {
  CHAMPION: "bg-cy/15 text-cy border-cy/40", SHADOW: "bg-vio/15 text-vio border-vio/40", APPROVED: "bg-up/15 text-up border-up/40", REJECTED: "bg-dn/10 text-dn border-dn/30",
  QUARANTINED: "bg-warn/15 text-warn border-warn/40", ROLLED_BACK: "bg-warn/15 text-warn border-warn/40", RETIRED: "bg-line text-dim border-line", BASELINE: "bg-raised text-dim border-line",
  CANDIDATE: "bg-raised text-text border-line", pass: "bg-up/15 text-up border-up/40", fail: "bg-dn/15 text-dn border-dn/40", warn: "bg-warn/15 text-warn border-warn/40", na: "bg-raised text-dim border-line",
  done: "bg-up/10 text-up border-up/30", running: "bg-cy/15 text-cy border-cy/40", queued: "bg-raised text-dim border-line", failed: "bg-dn/15 text-dn border-dn/40",
  FILLED: "bg-up/10 text-up border-up/30", EXPIRED: "bg-raised text-dim border-line", PARTIAL_CANCELLED: "bg-warn/15 text-warn border-warn/40",
  critical: "bg-dn/15 text-dn border-dn/40", warning: "bg-warn/15 text-warn border-warn/40", info: "bg-cy/10 text-cy border-cy/30",
};
export function Pill({ v, children }: any) {
  return <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide ${PILL[v] || "bg-raised text-dim border-line"}`}>{children ?? String(v).replace(/_/g, " ")}</span>;
}
export function Btn({ children, onClick, kind = "ghost", disabled, title }: any) {
  const k = kind === "danger" ? "border-dn/50 text-dn hover:bg-dn/10" : kind === "primary" ? "border-cy/50 text-cy hover:bg-cy/10" : "border-line text-text hover:bg-raised";
  return <button title={title} disabled={disabled} onClick={onClick} className={`px-2.5 py-1 rounded border text-xs ${k} disabled:opacity-40`}>{children}</button>;
}
export function Empty({ children }: any) { return <div className="text-dim text-xs py-6 text-center">{children}</div>; }
export function Loading({ error }: { error?: string | null }) {
  return <div className="p-10 text-center text-dim">{error ? <span className="text-dn">Backend unreachable: {error}</span> : <span className="pulse">loading…</span>}</div>;
}
export function Meter({ v, max = 100, color = "#22d3ee", label }: any) {
  const p = Math.max(0, Math.min(100, (v / max) * 100));
  return (
    <div>
      {label && <div className="flex justify-between text-[11px] text-dim mb-1"><span>{label}</span><span className="num">{f(v, 0)} / {f(max, 0)}</span></div>}
      <div className="h-1.5 bg-raised rounded overflow-hidden"><div className="h-full rounded transition-all duration-500" style={{ width: `${p}%`, background: p > 85 ? "#f87171" : color }} /></div>
    </div>
  );
}

/** Multi-series line chart (SVG) with hover read-out. series: [{name, color?, data:number[], dash?}] */
export function Lines({ series, height = 200, labels, zero = true, fmt = (v: number) => f(v, 0), yLabel }: any) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hi, setHi] = useState<number | null>(null);
  useEffect(() => { const ro = new ResizeObserver((e) => setW(e[0].contentRect.width)); if (ref.current) ro.observe(ref.current); return () => ro.disconnect(); }, []);
  const ss = (series || []).filter((s: any) => s.data && s.data.length);
  const n = Math.max(1, ...ss.map((s: any) => s.data.length));
  const all = ss.flatMap((s: any) => s.data.filter((v: any) => v !== null && Number.isFinite(v)));
  let lo = Math.min(...all, zero ? 0 : Infinity), hiV = Math.max(...all, zero ? 0 : -Infinity);
  if (!all.length) { lo = 0; hiV = 1; }
  if (hiV === lo) hiV = lo + 1;
  const L = 48, R = 8, T = 8, Bm = 18;
  const x = (i: number) => L + (n <= 1 ? 0 : (i / (n - 1)) * (w - L - R));
  const y = (v: number) => T + (1 - (v - lo) / (hiV - lo)) * (height - T - Bm);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => lo + t * (hiV - lo));
  return (
    <div ref={ref} className="relative select-none">
      <svg width={w} height={height} onMouseLeave={() => setHi(null)} onMouseMove={(e) => { const r = (e.currentTarget as any).getBoundingClientRect(); setHi(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left - L) / Math.max(1, w - L - R)) * (n - 1))))); }}>
        {ticks.map((t, i) => (<g key={i}><line x1={L} x2={w - R} y1={y(t)} y2={y(t)} stroke="#141c2a" /><text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="#7b8aa3" className="num">{fmt(t)}</text></g>))}
        {zero && lo < 0 && hiV > 0 && <line x1={L} x2={w - R} y1={y(0)} y2={y(0)} stroke="#33415580" strokeDasharray="3 3" />}
        {ss.map((s: any, k: number) => {
          let d = "", pen = false;
          s.data.forEach((v: any, i: number) => { if (v === null || !Number.isFinite(v)) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
          return <path key={k} d={d} fill="none" stroke={s.color || COLORS[k % COLORS.length]} strokeWidth={s.bold ? 2.2 : 1.3} strokeDasharray={s.dash ? "4 3" : undefined} opacity={s.faint ? 0.45 : 1} />;
        })}
        {hi !== null && <line x1={x(hi)} x2={x(hi)} y1={T} y2={height - Bm} stroke="#475569" />}
        {labels && [0, Math.floor(n / 2), n - 1].map((i) => labels[i] && <text key={i} x={x(i)} y={height - 4} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize="10" fill="#7b8aa3">{labels[i]}</text>)}
        {yLabel && <text x={4} y={10} fontSize="9" fill="#7b8aa3">{yLabel}</text>}
      </svg>
      {hi !== null && (
        <div className="absolute top-1 right-2 bg-ink/90 border border-line rounded px-2 py-1 text-[11px] pointer-events-none max-h-[90%] overflow-hidden">
          <div className="text-dim">{labels ? labels[hi] : `#${hi + 1}`}</div>
          {ss.slice(0, 12).map((s: any, k: number) => (<div key={k} className="flex gap-2 justify-between"><span style={{ color: s.color || COLORS[k % COLORS.length] }}>{s.name}</span><span className="num">{s.data[hi] == null ? "—" : fmt(s.data[hi])}</span></div>))}
        </div>
      )}
    </div>
  );
}

export function Hist({ counts, lo, hi, height = 110, color = "#22d3ee", mark, unit = "" }: any) {
  const max = Math.max(1, ...(counts || []));
  const n = (counts || []).length;
  return (
    <div>
      <div className="flex items-end gap-px" style={{ height }}>
        {(counts || []).map((c: number, i: number) => {
          const mid = lo + ((i + 0.5) / n) * (hi - lo);
          return <div key={i} title={`${f(lo + (i / n) * (hi - lo), 1)}…${f(lo + ((i + 1) / n) * (hi - lo), 1)}${unit}: ${c}`} className="flex-1 rounded-t-sm" style={{ height: `${(c / max) * 100}%`, minHeight: c ? 2 : 0, background: mark !== undefined ? (mid < mark ? "#f87171" : "#34d399") : color, opacity: 0.85 }} />;
        })}
      </div>
      <div className="flex justify-between text-[10px] text-dim num mt-1"><span>{lo}{unit}</span><span>{(lo + hi) / 2}{unit}</span><span>{hi}{unit}</span></div>
    </div>
  );
}

export function Spark({ data, color = "#22d3ee", w = 120, h = 28 }: any) {
  const d = (data || []).filter((v: any) => v != null);
  if (d.length < 2) return <svg width={w} height={h} />;
  const lo = Math.min(...d), hi = Math.max(...d);
  const p = d.map((v: number, i: number) => `${i ? "L" : "M"}${((i / (d.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4)).toFixed(1)}`).join("");
  return <svg width={w} height={h}><path d={p} fill="none" stroke={color} strokeWidth="1.3" /></svg>;
}

/** Candlestick chart (Lightweight Charts). candles: [{time, open, high, low, close, vwap?}], markers, lines:[{price,color,title}], dimAfter: time */
export function Candles({ candles, markers, lines, height = 300, vwap = true, dimAfter, onClickTime }: any) {
  const el = useRef<HTMLDivElement>(null);
  const key = useMemo(() => JSON.stringify([candles?.length, candles?.[0]?.time, candles?.[candles.length - 1]?.time, candles?.[candles.length - 1]?.close, markers?.length, dimAfter, lines]), [candles, markers, dimAfter, lines]);
  useEffect(() => {
    if (!el.current || !candles?.length) return;
    const chart = createChart(el.current, {
      height, layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#7b8aa3", fontSize: 10 },
      grid: { vertLines: { color: "#111826" }, horzLines: { color: "#111826" } }, rightPriceScale: { borderColor: "#1c2636" },
      timeScale: { borderColor: "#1c2636", timeVisible: true, secondsVisible: false }, crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: (t: number) => new Date(t * 1000).toLocaleString("en-CA", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " ET" },
    });
    (chart.timeScale() as any).applyOptions({ tickMarkFormatter: (t: number) => new Date(t * 1000).toLocaleTimeString("en-CA", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }) });
    const s = chart.addCandlestickSeries({ upColor: "#34d399", downColor: "#f87171", borderVisible: false, wickUpColor: "#34d399", wickDownColor: "#f87171" });
    s.setData(candles.map((c: any) => { const dim = dimAfter && c.time > dimAfter; const col = dim ? (c.close >= c.open ? "#34d39940" : "#f8717140") : undefined; return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, ...(dim ? { color: col, wickColor: col } : {}) }; }));
    if (vwap && candles[0].vwap !== undefined) { const v = chart.addLineSeries({ color: "#a78bfa", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); v.setData(candles.filter((c: any) => !dimAfter || c.time <= dimAfter).map((c: any) => ({ time: c.time, value: c.vwap }))); }
    if (markers?.length) s.setMarkers([...markers].sort((a: any, b: any) => a.time - b.time));
    (lines || []).forEach((l: any) => l.price != null && s.createPriceLine({ price: l.price, color: l.color || "#475569", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.title }));
    chart.timeScale().fitContent();
    if (onClickTime) chart.subscribeClick((p: any) => p.time && onClickTime(p.time));
    const ro = new ResizeObserver(() => el.current && chart.applyOptions({ width: el.current.clientWidth }));
    ro.observe(el.current);
    return () => { ro.disconnect(); chart.remove(); };
  }, [key, height]);
  return <div ref={el} style={{ height }} className="w-full" />;
}

export const evMarker = (e: any, sel?: number) => ({ time: e.time, position: e.direction > 0 ? "belowBar" : "aboveBar", color: e.id === sel ? "#fbbf24" : e.direction > 0 ? "#34d399" : "#f87171", shape: e.direction > 0 ? "arrowUp" : "arrowDown", text: e.id === sel ? e.pattern.replace(/_/g, " ") : "", id: String(e.id) });
export const REG = ["calm", "normal", "volatile"];
export const REGC = ["#38bdf8", "#94a3b8", "#fb923c"];

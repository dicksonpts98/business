import { useEffect, useRef, useState } from "react";

export async function get(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
export async function post(url: string) {
  const token = localStorage.getItem("ag_operator_token");
  const r = await fetch(url, { method: "POST", headers: token ? { "X-Operator-Token": token } : {} });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
/** Poll an endpoint. Returns the last good payload, the error (if the last call failed) and a manual refresh. */
export function useApi<T = any>(url: string | null, ms = 10000): { data: T | null; error: string | null; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tick = useRef(0);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    const id = ++tick.current;
    const load = () => get(url).then((d) => { if (live && id === tick.current) { setData(d); setError(null); } }).catch((e) => live && setError(String(e.message || e)));
    load();
    const t = ms ? setInterval(load, ms) : null;
    return () => { live = false; if (t) clearInterval(t); };
  }, [url, ms, n]);
  return { data, error, refresh: () => setN((x) => x + 1) };
}
export const f = (x: any, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? "—" : Number(x).toLocaleString("en-CA", { minimumFractionDigits: d, maximumFractionDigits: d }));
export const cad = (x: any, d = 0) => (x === null || x === undefined ? "—" : (x < 0 ? "−" : "") + "$" + Math.abs(Number(x)).toLocaleString("en-CA", { minimumFractionDigits: d, maximumFractionDigits: d }));
export const pct = (x: any, d = 0) => (x === null || x === undefined ? "—" : (Number(x) * 100).toFixed(d) + "%");
export const ago = (ts: number) => { if (!ts) return "—"; const s = Date.now() / 1000 - ts; return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
export const tone = (x: number) => (x > 0 ? "text-up" : x < 0 ? "text-dn" : "text-dim");

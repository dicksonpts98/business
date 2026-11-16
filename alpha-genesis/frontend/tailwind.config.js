/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: { extend: {
    colors: { ink: "#06090f", panel: "#0c111a", raised: "#111826", line: "#1c2636", dim: "#7b8aa3", text: "#d7e0ee",
              cy: "#22d3ee", up: "#34d399", dn: "#f87171", warn: "#fbbf24", vio: "#a78bfa" },
    fontFamily: { sans: ["Inter", "system-ui", "Segoe UI", "sans-serif"], mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Consolas", "monospace"] } } },
  plugins: [],
};

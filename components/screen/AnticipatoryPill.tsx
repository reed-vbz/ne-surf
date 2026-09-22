"use client";
/**
 * Anticipatory "zero-click" pill: floats top-centre in the band the search bar used to occupy and surfaces the best
 * break for the active hour from the live forecast (headline + wind outlook). Tapping it flies the map there and
 * opens the drawer. Pure presentation; the page computes the copy.
 */
export interface PillModel { headline: string; sub: string; accent: string }

export default function AnticipatoryPill({ p, onClick }: { p: PillModel; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label={`${p.headline}. ${p.sub}`} className="backdrop-blur-2xl bg-black/40 border border-white/20"
      style={{ maxWidth: "100%", height: 32, padding: "0 14px", borderRadius: 999, display: "flex", alignItems: "center", gap: 8, cursor: "pointer", color: "#ffffff", fontFamily: "'Barlow', system-ui, sans-serif", textAlign: "left",
        boxShadow: `0 6px 20px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.04), 0 0 18px ${p.accent}33` }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: p.accent, boxShadow: `0 0 10px ${p.accent}`, flexShrink: 0 }} />
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.headline}</span>
      <span style={{ fontSize: 10, fontWeight: 500, color: "#cfe0ea", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} className="hidden sm:inline">{p.sub}</span>
    </button>
  );
}

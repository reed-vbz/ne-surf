"use client";
/**
 * Full-forecast strip: the second row of the glass header, above the timeline. The best break at the active hour
 * surfaces itself (zero-click) with the whole picture on two lines — waves, period and direction, wind and its
 * alignment, tide, the hour. Tapping flies the map there and opens the drawer. Pure presentation.
 */
export interface StripModel { headline: string; detail: string; accent: string }

export default function ForecastStrip({ f, onClick }: { f: StripModel; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label={`${f.headline}. ${f.detail}`}
      style={{ width: "100%", height: 44, padding: "0 16px", border: 0, background: "transparent", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", color: "#ffffff", fontFamily: "'Barlow', system-ui, sans-serif", textAlign: "left" }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: f.accent, boxShadow: `0 0 10px ${f.accent}`, flexShrink: 0 }} />
      <span style={{ minWidth: 0, display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.headline}</span>
        <span style={{ fontSize: 10, fontWeight: 500, color: "#cfe0ea", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.detail}</span>
      </span>
    </button>
  );
}

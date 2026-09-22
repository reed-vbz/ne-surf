"use client";
/**
 * 1:1 port of design/ne-surf-handoff/ui-reference.html (v2, 2026-09-22: mode chips removed, Layers control → Forecast drawer control). Every px, hex, radius, opacity and font value below is
 * copied from that file; only the text content and the map slot are props. Do not restyle from memory —
 * change ui-reference.html first, then this file, then pass `npm run diff`.
 *
 * Non-visual liberties (identical at 390×844): right-anchored panels use `right` instead of a hard `left`;
 * the 24px chevrons and 8px segments carry invisible ≥44px hit areas (.hit44 / .hit44-seg).
 */
import type { CSSProperties, ReactNode } from "react";
import AnticipatoryPill, { type PillModel } from "./AnticipatoryPill";

export interface ScreenModel {
  dateLabel: string;
  days: Array<{ name: string; filled: boolean; active: boolean }>;
  selectedIndex: number;
  layerCard: { title: string; body: string };
  callouts: Array<{ id: string; name: string; body: string; left: number; top: number; color?: string }>;
  hotspot: { rating: string; ratingColor: string; line1: string; line2: string; pinColor: string };
  /** anticipatory zero-click pill (replaced the search bar 2026-09-22) */
  pill: PillModel;
  /** position of the timeline knob inside the active day (0–1); undefined = centred, as in ui-reference.html */
  knobFraction?: number;
}

export interface ScreenHandlers {
  onPrev: () => void; onNext: () => void; onPickDay: (i: number) => void;
  onPill: () => void;
  onForecast: () => void; onMenu: () => void; onHotspot: () => void;
}

const panelTitle10: CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "#e8eef2" };
const legendCard: CSSProperties = { borderRadius: 8, background: "#0e212a", boxShadow: "0px 4px 14px rgba(0,0,0,0.35)", boxSizing: "border-box", padding: "8px 10px 8px 10px", display: "flex", flexDirection: "column", gap: 6 };
const legendRow: CSSProperties = { display: "flex", justifyContent: "space-between", fontSize: 10, fontWeight: 500, color: "#ffffff" };
const calloutStyle = (left: number, top: number): CSSProperties => ({
  position: "absolute", left, top, height: 24, padding: "0px 8px", borderRadius: 4, background: "#0e212a", boxShadow: "0px 3px 10px rgba(0,0,0,0.4)",
  display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", fontSize: 10, fontWeight: 500, color: "#ffffff", zIndex: 3,
});
const pill = (hex: string) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
    <div style={{ width: "100%", height: 8, borderRadius: 4, background: hex }} />
    <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: hex }}>{hex === "#41c776" ? "Green" : hex === "#f3c79e" ? "Moderate" : "Poor"}</div>
  </div>
);

export default function OverviewScreen({ m, h, map, children }: { m: ScreenModel; h: ScreenHandlers; map: ReactNode; children?: ReactNode }) {
  const pct = ((m.selectedIndex + (m.knobFraction ?? 0.5)) / 7) * 100;
  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", background: "#0e2029", boxSizing: "border-box", fontFamily: "'Barlow', system-ui, sans-serif" }}>

      {/* MAP LAYER */}
      {map}

      {/* HEADER (safe-area 40px + 44px bar) */}
      <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: 84, background: "#0e2029", boxSizing: "border-box", padding: "40px 16px 0px 16px", display: "flex", alignItems: "center", gap: 12, zIndex: 5 }}>
        <div style={{ width: 28, height: 28, borderRadius: 6, background: "#4798b7", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0e2029" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 17 9 11 13 15 21 7"></polyline><polyline points="15 7 21 7 21 13"></polyline></svg>
        </div>
        <div style={{ flexGrow: 1, fontSize: 15, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "#e8eef2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>NE Surf Overview (Free Map)</div>
        <button aria-label="Open menu" onClick={h.onMenu} style={{ width: 44, height: 44, marginRight: -12, background: "transparent", border: 0, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e8eef2" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line></svg>
        </button>
      </div>

      {/* ANTICIPATORY PILL (replaced the search bar 2026-09-22: zero-click, the best break for this hour surfaces itself) */}
      <div style={{ position: "absolute", left: 0, top: 84, width: "100%", height: 44, boxSizing: "border-box", padding: "0px 12px", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 5 }}>
        <AnticipatoryPill p={m.pill} onClick={h.onPill} />
      </div>

      {/* 7-DAY TIMELINE */}
      <div style={{ position: "absolute", left: 6, right: 6, top: 136, height: 68, borderRadius: 10, background: "#0e212a", boxShadow: "0px 6px 18px rgba(0,0,0,0.35)", boxSizing: "border-box", padding: "8px 10px 6px 10px", display: "flex", flexDirection: "column", gap: 6, zIndex: 6 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", alignItems: "center" }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "#e8eef2" }}>7-Day Timeline</div>
          <div style={{ textAlign: "center", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#cfe0ea" }}>{m.dateLabel}</div>
          <div></div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button aria-label="Previous day" onClick={h.onPrev} className="hit44" style={{ width: 24, height: 24, marginLeft: -6, background: "transparent", border: 0, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e8eef2" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 5 8 12 15 19"></polyline></svg>
          </button>
          <div style={{ flexGrow: 1, position: "relative", height: 16, display: "flex", alignItems: "center" }}>
            <div style={{ flexGrow: 1, display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 2, height: 8 }}>
              {m.days.map((d, i) => (
                <button key={d.name + i} aria-label={d.name} onClick={() => h.onPickDay(i)} className="hit44-seg" style={{ height: 8, border: 0, padding: 0, borderRadius: 2, cursor: "pointer", background: d.filled ? "#4798b7" : "#2c3f49" }}></button>
              ))}
            </div>
            <div style={{ position: "absolute", top: 0, left: `calc(${pct.toFixed(3)}% - 8px)`, width: 16, height: 16, borderRadius: 8, background: "#f0f5f1", boxShadow: "0px 1px 4px rgba(0,0,0,0.5)", pointerEvents: "none", transition: "left 200ms ease" }}></div>
          </div>
          <button aria-label="Next day" onClick={h.onNext} className="hit44" style={{ width: 24, height: 24, marginRight: -6, background: "transparent", border: 0, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e8eef2" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 5 16 12 9 19"></polyline></svg>
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", padding: "0px 18px" }}>
          {m.days.map((d, i) => (
            <div key={d.name + i} style={{ textAlign: "center", fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: d.active ? "#ffffff" : "#9fb1bc" }}>{d.name}</div>
          ))}
        </div>
      </div>

      {/* LAYER INFO CARD */}
      <div style={{ position: "absolute", left: 8, top: 212, width: 188, borderRadius: 8, background: "#0e212a", boxShadow: "0px 4px 14px rgba(0,0,0,0.35)", boxSizing: "border-box", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 2, zIndex: 4 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: "#e8eef2" }}>{m.layerCard.title}</div>
        <div style={{ fontSize: 10, fontWeight: 500, color: "#b8c7d1", lineHeight: 1.3 }}>{m.layerCard.body}</div>
      </div>

      {/* MAP CONTROL: FORECAST DRAWER */}
      <button aria-label="Surf forecast" onClick={h.onForecast} className="hit44" style={{ position: "absolute", right: 8, top: 254, width: 40, height: 40, borderRadius: 8, background: "#0e212a", border: "1px solid rgba(255,255,255,0.14)", boxShadow: "0px 4px 14px rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 4 }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#e8eef2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 16 8 10 12 14 16 7 21 11"></polyline><line x1="3" y1="20" x2="21" y2="20"></line></svg>
      </button>

      {/* BREAK CALLOUTS */}
      {m.callouts.map((c) => (
        <div key={c.id} style={calloutStyle(c.left, c.top)}>
          <span style={{ fontWeight: 700, color: c.color ?? "#41c776", letterSpacing: "0.02em" }}>{c.name}:</span>
          <span>{c.body}</span>
        </div>
      ))}

      {/* LEGENDS */}
      <div style={{ position: "absolute", left: 12, bottom: 8, width: 156, display: "flex", flexDirection: "column", gap: 8, zIndex: 4 }}>
        <div style={legendCard}>
          <div style={panelTitle10}>Swell Interaction</div>
          <div style={{ height: 8, borderRadius: 4, background: "linear-gradient(90deg, #64d5cc 0%, #4798b7 40%, #2b5bc7 75%, #163797 100%)" }}></div>
          <div style={legendRow}><span>Low</span><span>Clean</span><span>High</span></div>
        </div>
        <div style={legendCard}>
          <div style={panelTitle10}>Wind Overlay</div>
          <div style={{ height: 8, borderRadius: 4, background: "linear-gradient(90deg, #27a055 0%, #a8c24a 45%, #f0a24a 75%, #e66729 100%)" }}></div>
          <div style={legendRow}><span>Offshore</span><span>Cross-shore</span></div>
        </div>
      </div>

      {/* HOTSPOT CARD */}
      <div role="button" tabIndex={0} onClick={h.onHotspot} onKeyDown={(e) => e.key === "Enter" && h.onHotspot()} style={{ position: "absolute", right: 8, bottom: 8, width: 152, borderRadius: 8, background: "#0e212a", border: "1px solid rgba(255,255,255,0.10)", boxShadow: "0px 4px 14px rgba(0,0,0,0.35)", boxSizing: "border-box", padding: "10px 10px 10px 10px", display: "flex", flexDirection: "column", gap: 6, zIndex: 4, cursor: "pointer" }}>
        <div style={panelTitle10}>Surf Quality Hotspot</div>
        <div style={{ fontSize: 8, fontWeight: 600, letterSpacing: "0.10em", textTransform: "uppercase", color: "#b8c7d1" }}>AI-ranked breaks</div>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 2 }}>
          <svg width="16" height="20" viewBox="0 0 16 20" fill={m.hotspot.pinColor} style={{ flexShrink: 0, marginTop: 1 }}><path d="M8 0 C3.6 0 0 3.5 0 7.8 C0 13.4 8 20 8 20 C8 20 16 13.4 16 7.8 C16 3.5 12.4 0 8 0 Z"></path><circle cx="8" cy="7.8" r="3" fill="#0e2029"></circle></svg>
          <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: m.hotspot.ratingColor }}>{m.hotspot.rating}</div>
            <div style={{ fontSize: 10, fontWeight: 500, color: "#ffffff", lineHeight: 1.3 }}>{m.hotspot.line1}</div>
            <div style={{ fontSize: 10, fontWeight: 500, color: "#ffffff", lineHeight: 1.3 }}>{m.hotspot.line2}</div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6, marginTop: 4 }}>
          {pill("#41c776")}{pill("#f3c79e")}{pill("#9c9ea1")}
        </div>
      </div>

      {children}
    </div>
  );
}

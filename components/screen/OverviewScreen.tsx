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
import ForecastStrip, { type StripModel } from "./ForecastStrip";

export interface ScreenModel {
  dateLabel: string;
  days: Array<{ name: string; filled: boolean; active: boolean }>;
  selectedIndex: number;
  callouts: Array<{ id: string; name: string; body: string; left: number; top: number; color?: string }>;
  hotspot: { rating: string; ratingColor: string; line1: string; line2: string; pinColor: string };
  /** full forecast for the best break at the active hour: second row of the glass header (2026-09-22 v4) */
  forecast: StripModel;
  /** position of the timeline knob inside the active day (0–1); undefined = centred, as in ui-reference.html */
  knobFraction?: number;
}

export interface ScreenHandlers {
  onPrev: () => void; onNext: () => void; onPickDay: (i: number) => void;
  onStrip: () => void;
  onForecast: () => void; onMenu: () => void; onHotspot: () => void;
}

export const dockCard: CSSProperties = { flex: "none", width: 148, height: 164, borderRadius: 12, background: "rgba(14,33,42,0.72)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", border: "1px solid rgba(255,255,255,0.10)", boxShadow: "0px 8px 24px rgba(0,0,0,0.35)", boxSizing: "border-box", padding: "10px 10px 8px 10px", display: "flex", flexDirection: "column", gap: 6, scrollSnapAlign: "start" };
export const panelTitle9: CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#e8eef2" };
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

export default function OverviewScreen({ m, h, map, dockExtras, children }: { m: ScreenModel; h: ScreenHandlers; map: ReactNode; dockExtras?: ReactNode; children?: ReactNode }) {
  const pct = ((m.selectedIndex + (m.knobFraction ?? 0.5)) / 7) * 100;
  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "hidden", background: "#0e2029", boxSizing: "border-box", fontFamily: "'Barlow', system-ui, sans-serif" }}>

      {/* MAP LAYER */}
      {map}

      {/* HEADER (safe-area 40px + 44px bar) */}
      <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: 84, background: "rgba(14,32,41,0.72)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)", boxSizing: "border-box", padding: "40px 16px 0px 16px", display: "flex", alignItems: "center", gap: 12, zIndex: 5 }}>
        <div style={{ width: 28, height: 28, borderRadius: 6, background: "#4798b7", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0e2029" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 17 9 11 13 15 21 7"></polyline><polyline points="15 7 21 7 21 13"></polyline></svg>
        </div>
        <div style={{ flexGrow: 1, fontSize: 15, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: "#e8eef2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>NE Surf Overview (Free Map)</div>
        <button aria-label="Open menu" onClick={h.onMenu} style={{ width: 44, height: 44, marginRight: -12, background: "transparent", border: 0, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e8eef2" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line></svg>
        </button>
      </div>

      {/* FULL FORECAST STRIP — second row of the glass header (v4 2026-09-22: replaced the pill band + layer card) */}
      <div style={{ position: "absolute", left: 0, top: 84, width: "100%", height: 44, background: "rgba(14,32,41,0.72)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)", borderBottom: "1px solid rgba(255,255,255,0.10)", boxSizing: "border-box", zIndex: 5 }}>
        <ForecastStrip f={m.forecast} onClick={h.onStrip} />
      </div>

      {/* 7-DAY TIMELINE */}
      <div style={{ position: "absolute", left: 6, right: 6, top: 136, height: 68, borderRadius: 10, background: "rgba(14,33,42,0.78)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0px 6px 18px rgba(0,0,0,0.35)", boxSizing: "border-box", padding: "8px 10px 6px 10px", display: "flex", flexDirection: "column", gap: 6, zIndex: 6 }}>
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

      {/* MAP CONTROL: FORECAST DRAWER */}
      <button aria-label="Surf forecast" onClick={h.onForecast} className="hit44" style={{ position: "absolute", right: 8, top: 254, width: 40, height: 40, borderRadius: 8, background: "rgba(14,33,42,0.7)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", border: "1px solid rgba(255,255,255,0.14)", boxShadow: "0px 4px 14px rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 4 }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#e8eef2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 16 8 10 12 14 16 7 21 11"></polyline><line x1="3" y1="20" x2="21" y2="20"></line></svg>
      </button>

      {/* BREAK CALLOUTS */}
      {m.callouts.map((c) => (
        <div key={c.id} style={calloutStyle(c.left, c.top)}>
          <span style={{ fontWeight: 700, color: c.color ?? "#41c776", letterSpacing: "0.02em" }}>{c.name}:</span>
          <span>{c.body}</span>
        </div>
      ))}

      {/* WIDGET DOCK (v5 2026-09-22: OS-style row of uniform glass cards; scroll-snaps on phones, one row on desktop) */}
      <div className="nesurf-dock" style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "0px 8px 8px 8px", display: "flex", gap: 8, alignItems: "stretch", overflowX: "auto", scrollSnapType: "x mandatory", scrollbarWidth: "none", zIndex: 4 }}>
        <div role="button" tabIndex={0} onClick={h.onHotspot} onKeyDown={(e) => e.key === "Enter" && h.onHotspot()} style={{ ...dockCard, cursor: "pointer" }}>
          <div style={panelTitle9}>Surf Quality Hotspot</div>
          <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <svg width="16" height="20" viewBox="0 0 16 20" fill={m.hotspot.pinColor} style={{ flexShrink: 0, marginTop: 1 }}><path d="M8 0 C3.6 0 0 3.5 0 7.8 C0 13.4 8 20 8 20 C8 20 16 13.4 16 7.8 C16 3.5 12.4 0 8 0 Z"></path><circle cx="8" cy="7.8" r="3" fill="#0e2029"></circle></svg>
            <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: m.hotspot.ratingColor }}>{m.hotspot.rating}</div>
              <div style={{ fontSize: 10, fontWeight: 500, color: "#ffffff", lineHeight: 1.3 }}>{m.hotspot.line1}</div>
              <div style={{ fontSize: 10, fontWeight: 500, color: "#ffffff", lineHeight: 1.3 }}>{m.hotspot.line2}</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6, marginTop: "auto" }}>
            {pill("#41c776")}{pill("#f3c79e")}{pill("#9c9ea1")}
          </div>
        </div>
        {dockExtras}
        <div style={dockCard}>
          <div style={panelTitle9}>Legend</div>
          <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#b8c7d1" }}>Swell energy</div>
          <div style={{ height: 8, borderRadius: 4, background: "linear-gradient(90deg, #64d5cc 0%, #4798b7 40%, #2b5bc7 75%, #163797 100%)" }}></div>
          <div style={legendRow}><span>Low</span><span>Clean</span><span>High</span></div>
          <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#b8c7d1", marginTop: 4 }}>Wind on the beach</div>
          <div style={{ height: 8, borderRadius: 4, background: "linear-gradient(90deg, #27a055 0%, #a8c24a 45%, #f0a24a 75%, #e66729 100%)" }}></div>
          <div style={legendRow}><span>Offshore</span><span>Onshore</span></div>
        </div>
      </div>
      <style>{`.nesurf-dock::-webkit-scrollbar{display:none}`}</style>

      {children}
    </div>
  );
}

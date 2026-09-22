"use client";
/**
 * 1:1 port of design/ne-surf-handoff/ui-reference.html (v6, 2026-09-22: one compact glass header = title row + 7-day forecast timeline; widget dock). Every px, hex, radius, opacity and font value below is
 * copied from that file; only the text content and the map slot are props. Do not restyle from memory —
 * change ui-reference.html first, then this file, then pass `npm run diff`.
 *
 * Non-visual liberties (identical at 390×844): right-anchored panels use `right` instead of a hard `left`;
 * the 24px chevrons and 8px segments carry invisible ≥44px hit areas (.hit44 / .hit44-seg).
 */
import type { CSSProperties, ReactNode } from "react";
import { WIND_ALIGN } from "@/lib/colors";

export interface ScreenModel {
  dateLabel: string;
  days: Array<{ name: string; filled: boolean; active: boolean; range: string; meta: string; tierColor: string }>;
  selectedIndex: number;
  callouts: Array<{ id: string; name: string; body: string; left: number; top: number; color?: string }>;
  hotspot: { rating: string; ratingColor: string; line1: string; line2: string; pinColor: string };
  /** position of the timeline knob inside the active day (0–1); undefined = centred, as in ui-reference.html */
  knobFraction?: number;
}

export interface ScreenHandlers {
  onPrev: () => void; onNext: () => void; onPickDay: (i: number) => void;
  onForecast: () => void; onMenu: () => void; onHotspot: () => void;
}

export const dockCard: CSSProperties = { flex: "none", width: "clamp(216px, 66vw, 256px)", height: 192, borderRadius: 12, background: "rgba(10,24,34,0.90)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", border: "1px solid rgba(255,255,255,0.10)", boxShadow: "0px 8px 24px rgba(0,0,0,0.35)", boxSizing: "border-box", padding: "10px 10px 8px 10px", display: "flex", flexDirection: "column", gap: 6, scrollSnapAlign: "start" };
export const panelTitle9: CSSProperties = { fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#e8eef2" };
const legendRow: CSSProperties = { display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 500, color: "#ffffff" };
const calloutStyle = (left: number, top: number): CSSProperties => ({
  position: "absolute", left, top, height: 24, padding: "0px 8px", borderRadius: 4, background: "#0e212a", boxShadow: "0px 3px 10px rgba(0,0,0,0.4)",
  display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap", fontSize: 12, fontWeight: 500, color: "#ffffff", zIndex: 3,
});
const pill = (hex: string) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
    <div style={{ width: "100%", height: 8, borderRadius: 4, background: hex }} />
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: hex }}>{hex === "#41c776" ? "Green" : hex === "#f3c79e" ? "Moderate" : "Poor"}</div>
  </div>
);

export default function OverviewScreen({ m, h, map, dockExtras, children }: { m: ScreenModel; h: ScreenHandlers; map: ReactNode; dockExtras?: ReactNode; children?: ReactNode }) {
  const pct = ((m.selectedIndex + (m.knobFraction ?? 0.5)) / 7) * 100;
  return (
    <div style={{ width: "100%", height: "100%", position: "relative", overflow: "clip", background: "#0e2029", boxSizing: "border-box", fontFamily: "'Barlow', system-ui, sans-serif" }}>

      {/* MAP LAYER */}
      {map}

      {/* COMPACT HEADER (v6 2026-09-22): one glass bar — slim title row + the 7-day forecast timeline (each day carries its own forecast) */}
      <div style={{ position: "absolute", left: 0, top: 0, width: "100%", background: "rgba(14,32,41,0.72)", backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)", borderBottom: "1px solid rgba(255,255,255,0.10)", boxSizing: "border-box", padding: "calc(8px + env(safe-area-inset-top)) 12px 8px 12px", zIndex: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, height: 28 }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, background: "#4798b7", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0e2029" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 17 9 11 13 15 21 7"></polyline><polyline points="15 7 21 7 21 13"></polyline></svg>
          </div>
          <div style={{ flexGrow: 1, fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#e8eef2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>NE Surf Overview</div>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#cfe0ea", whiteSpace: "nowrap" }}>{m.dateLabel}</div>
          <button aria-label="Open menu" onClick={h.onMenu} style={{ width: 44, height: 44, marginRight: -12, background: "transparent", border: 0, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#e8eef2" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line></svg>
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 6 }}>
          <button aria-label="Previous day" onClick={h.onPrev} className="hit44" style={{ width: 24, height: 24, marginLeft: -6, background: "transparent", border: 0, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e8eef2" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 5 8 12 15 19"></polyline></svg>
          </button>
          <div style={{ flexGrow: 1, position: "relative", display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 2 }}>
            {m.days.map((d, i) => (
              <button key={d.name + i} aria-label={`${d.name} best window ${d.range}`} onClick={() => h.onPickDay(i)} style={{ height: 56, padding: 0, background: "transparent", border: 0, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", gap: 2, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: d.active ? "#ffffff" : "#9fb1bc" }}>{d.name}</div>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#ffffff", whiteSpace: "nowrap" }}>{d.range}</div>
                <div style={{ fontSize: 11, fontWeight: 500, color: "#b8c7d1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{d.meta}</div>
                <div style={{ width: "100%", height: 6, borderRadius: 3, marginTop: "auto", background: d.tierColor, opacity: d.filled ? 1 : 0.4 }}></div>
              </button>
            ))}
            <div style={{ position: "absolute", top: 42, left: `calc(${pct.toFixed(3)}% - 7px)`, width: 14, height: 14, borderRadius: 7, background: "#f0f5f1", boxShadow: "0px 1px 4px rgba(0,0,0,0.5)", pointerEvents: "none", transition: "left 200ms ease" }}></div>
          </div>
          <button aria-label="Next day" onClick={h.onNext} className="hit44" style={{ width: 24, height: 24, marginRight: -6, background: "transparent", border: 0, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#e8eef2" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 5 16 12 9 19"></polyline></svg>
          </button>
        </div>
      </div>

      {/* MAP CONTROL: FORECAST DRAWER */}
      <button aria-label="Surf forecast" onClick={h.onForecast} className="hit44" style={{ position: "absolute", right: 8, top: 118, width: 40, height: 40, borderRadius: 8, background: "rgba(14,33,42,0.7)", backdropFilter: "blur(18px)", WebkitBackdropFilter: "blur(18px)", border: "1px solid rgba(255,255,255,0.14)", boxShadow: "0px 4px 14px rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", zIndex: 4 }}>
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
      <div className="nesurf-dock" style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "0 8px calc(8px + env(safe-area-inset-bottom))", display: "flex", gap: 8, alignItems: "stretch", overflowX: "auto", scrollSnapType: "x mandatory", scrollbarWidth: "none", zIndex: 4 }}>
        <div role="button" tabIndex={0} onClick={h.onHotspot} onKeyDown={(e) => e.key === "Enter" && h.onHotspot()} style={{ ...dockCard, cursor: "pointer" }}>
          <div style={panelTitle9}>Surf Quality Hotspot</div>
          <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <svg width="16" height="20" viewBox="0 0 16 20" fill={m.hotspot.pinColor} style={{ flexShrink: 0, marginTop: 1 }}><path d="M8 0 C3.6 0 0 3.5 0 7.8 C0 13.4 8 20 8 20 C8 20 16 13.4 16 7.8 C16 3.5 12.4 0 8 0 Z"></path><circle cx="8" cy="7.8" r="3" fill="#0e2029"></circle></svg>
            <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: m.hotspot.ratingColor }}>{m.hotspot.rating}</div>
              <div style={{ fontSize: 12, fontWeight: 500, color: "#ffffff", lineHeight: 1.3 }}>{m.hotspot.line1}</div>
              <div style={{ fontSize: 12, fontWeight: 500, color: "#ffffff", lineHeight: 1.3 }}>{m.hotspot.line2}</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6, marginTop: "auto" }}>
            {pill("#41c776")}{pill("#f3c79e")}{pill("#9c9ea1")}
          </div>
        </div>
        {dockExtras}
        <div style={dockCard}>
          <div style={panelTitle9}>Legend</div>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#b8c7d1" }}>Ocean depth · m</div>
          <div style={{ height: 8, borderRadius: 4, background: "linear-gradient(90deg, #387477 0%, #2E666F 25%, #235665 50%, #13384C 75%, #091725 100%)" }}></div>
          <div style={legendRow}><span>0</span><span>2</span><span>5</span><span>20</span><span>150+</span></div>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#b8c7d1", marginTop: 4 }}>Wind on the beach</div>
          <div style={{ height: 8, borderRadius: 4, background: `linear-gradient(90deg, ${WIND_ALIGN.offshore}, ${WIND_ALIGN.cross}, ${WIND_ALIGN.onshore})` }}></div>
          <div style={legendRow}><span>Off</span><span>Cross</span><span>On</span></div>
          <div style={{ fontSize: 11, color: "#b9d3df" }}>Pale: light wind · Gray: unavailable</div>
        </div>
      </div>
      <style>{`.nesurf-dock::-webkit-scrollbar{display:none}`}</style>

      {children}
    </div>
  );
}

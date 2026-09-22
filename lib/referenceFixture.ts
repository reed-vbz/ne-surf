/** The exact content of design/ne-surf-handoff/ui-reference.html, used by the Phase A pixel diff. */
import type { ScreenModel } from "@/components/screen/OverviewScreen";

export const REFERENCE_MODEL: ScreenModel = {
  dateLabel: "Tue, Sept 22",
  days: ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"].map((name, i) => ({ name, filled: i <= 3, active: i === 3 })),
  selectedIndex: 3,
  layerCard: { title: "Swell Interaction", body: "Deep-water refraction, color-coded" },
  callouts: [
    { id: "higgins", name: "HIGGINS", body: "4-6ft @ 12s (SE) | NW Wind", left: 204, top: 214 },
    { id: "ruggles", name: "RUGGLES", body: "6-8ft @ 14s (SSW) | NNE Wind", left: 92, top: 566 },
  ],
  hotspot: { rating: "Excellent", ratingColor: "#41c776", line1: "Higgins: 4-6ft @ 12s", line2: "NW wind · Optimal", pinColor: "#41c776" },
  pill: { headline: "⚡ Higgins is firing: 4–6 ft @ 12 s", sub: "Offshore winds peaking at 2 PM", accent: "#41c776" },
};

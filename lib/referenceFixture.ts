/** The exact content of design/ne-surf-handoff/ui-reference.html, used by the Phase A pixel diff. */
import type { ScreenModel } from "@/components/screen/OverviewScreen";

export const REFERENCE_MODEL: ScreenModel = {
  dateLabel: "Tue, Sept 22",
  days: [
    { name: "Sat", filled: true, active: false, range: "2–3 ft", meta: "8 s · NW", tierColor: "#f3c79e" },
    { name: "Sun", filled: true, active: false, range: "3–4 ft", meta: "9 s · N", tierColor: "#f3c79e" },
    { name: "Mon", filled: true, active: false, range: "2–3 ft", meta: "7 s · SW", tierColor: "#9c9ea1" },
    { name: "Tue", filled: true, active: true, range: "4–6 ft", meta: "12 s · SE", tierColor: "#41c776" },
    { name: "Wed", filled: false, active: false, range: "3–4 ft", meta: "10 s · E", tierColor: "#f3c79e" },
    { name: "Thu", filled: false, active: false, range: "1–2 ft", meta: "6 s · S", tierColor: "#9c9ea1" },
    { name: "Fri", filled: false, active: false, range: "2–3 ft", meta: "8 s · SE", tierColor: "#9c9ea1" },
  ],
  selectedIndex: 3,
  callouts: [
    { id: "higgins", name: "HIGGINS", body: "4-6ft @ 12s (SE) | NW Wind", left: 204, top: 214 },
    { id: "ruggles", name: "RUGGLES", body: "6-8ft @ 14s (SSW) | NNE Wind", left: 92, top: 566 },
  ],
  hotspot: { rating: "Excellent", ratingColor: "#41c776", line1: "Higgins: 4-6ft @ 12s", line2: "NW wind · Optimal", pinColor: "#41c776" },
};

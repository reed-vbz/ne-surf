"use client";
import { useState } from "react";
import OverviewScreen, { type ScreenModel } from "@/components/screen/OverviewScreen";
import { REFERENCE_MODEL } from "@/lib/referenceFixture";

/** Phase A: the chrome over the static map placeholder, exactly as design/ne-surf-handoff/ui-reference.html. */
export default function Page() {
  const [m, setM] = useState<ScreenModel>(REFERENCE_MODEL);
  const pick = (i: number) => setM((s) => ({ ...s, selectedIndex: i, days: s.days.map((d, k) => ({ ...d, filled: k <= i, active: k === i })) }));
  return (
    <main style={{ position: "fixed", inset: 0 }}>
      <OverviewScreen m={m}
        h={{ onPrev: () => pick(Math.max(0, m.selectedIndex - 1)), onNext: () => pick(Math.min(6, m.selectedIndex + 1)), onPickDay: pick,
             onMode: (mode) => setM((s) => ({ ...s, mode })), onSearch: (q) => setM((s) => ({ ...s, searchValue: q })), onLayers: () => {}, onMenu: () => {}, onHotspot: () => {} }}
        map={<img src="/design/map_layer.jpg" alt="Satellite map of the New England coast with swell and wind overlays" style={{ position: "absolute", left: 0, top: 140, width: "100%", height: "calc(100% - 140px)", objectFit: "cover", display: "block" }} />} />
    </main>
  );
}

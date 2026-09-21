"use client";
/** Spec §03/§06: 7 segments 8 px tall, 2 px gap, r2; accent fill to the selected day; 16 px white knob; chevrons; day labels. */
export interface Day { key: string; label: string; short: string }

export default function DayTimeline({ days, index, onChange }: { days: Day[]; index: number; onChange: (i: number) => void }) {
  const n = Math.max(1, days.length);
  const knobLeft = `calc(${((index + 0.5) / n) * 100}% )`;
  return (
    <div className="panel px-[10px] pb-[6px] pt-2" style={{ borderRadius: 10 }}>
      <div className="flex items-center justify-between">
        <span className="t-panel text-t1">7-day timeline</span>
        <span className="text-[11px] font-semibold uppercase tracking-[.04em] text-t1">{days[index]?.label ?? "—"}</span>
        <span className="w-16" />
      </div>
      <div className="mt-[6px] flex items-center gap-1">
        <button aria-label="Previous day" onClick={() => onChange(Math.max(0, index - 1))} className="grid h-6 w-6 shrink-0 place-items-center text-t2">‹</button>
        <div className="relative flex h-6 flex-1 items-center">
          <div className="flex w-full gap-[2px]">
            {days.map((d, i) => (
              <button key={d.key} aria-label={d.label} onClick={() => onChange(i)} className="h-2 flex-1 rounded-[2px] transition-colors duration-200"
                style={{ background: i <= index ? "var(--accent)" : "var(--track-empty)" }} />))}
          </div>
          <div className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-[left] duration-200 ease-out" style={{ left: knobLeft }} />
        </div>
        <button aria-label="Next day" onClick={() => onChange(Math.min(n - 1, index + 1))} className="grid h-6 w-6 shrink-0 place-items-center text-t2">›</button>
      </div>
      <div className="mt-[6px] flex px-7">
        {days.map((d, i) => <span key={d.key} className="t-day flex-1 text-center" style={{ color: i === index ? "#fff" : "var(--text-3)" }}>{d.short}</span>)}
      </div>
    </div>
  );
}

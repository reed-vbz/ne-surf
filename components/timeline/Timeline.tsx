"use client";
import { useEffect, useRef } from "react";

interface Props {
  steps: Array<{ hour: number; valid_time: string }>;
  index: number;
  onChange: (i: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
}

const fmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", timeZone: "America/New_York" });
const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/New_York" });

export default function Timeline({ steps, index, onChange, playing, onTogglePlay }: Props) {
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => onChangeRef.current((index + 1) % steps.length), 900);
    return () => clearInterval(id);
  }, [playing, index, steps.length]);

  const step = steps[index];
  const days = Array.from({ length: 8 }, (_, d) => d);
  const pct = steps.length > 1 ? (index / (steps.length - 1)) * 100 : 0;
  return (
    <div className="rounded-xl border border-white/10 bg-[#0b1526]/90 px-4 py-3 text-slate-100 shadow-2xl backdrop-blur">
      <div className="flex items-center gap-3">
        <button onClick={onTogglePlay} aria-label={playing ? "Pause" : "Play"}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-cyan-400 text-[#0b1526] shadow-[0_0_16px_rgba(34,211,238,.5)]">
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">7-day timeline</span>
            <span className="text-sm font-semibold text-white">{step ? fmt.format(new Date(step.valid_time)) : "—"}</span>
            <span className="text-[10px] tabular-nums text-slate-400">+{step?.hour ?? 0} h</span>
          </div>
          <div className="relative h-5">
            <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-slate-700" />
            <div className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-cyan-400" style={{ width: `${pct}%` }} />
            <input type="range" min={0} max={Math.max(0, steps.length - 1)} value={index} onChange={(e) => onChange(Number(e.target.value))}
              aria-label="Forecast hour" className="timeline-range absolute inset-0 w-full cursor-pointer appearance-none bg-transparent" />
          </div>
          <div className="flex justify-between text-[10px] uppercase tracking-wider text-slate-400">
            {days.map((d) => <span key={d}>{steps[0] ? wd.format(new Date(Date.parse(steps[0].valid_time) + d * 86_400_000)) : `+${d}d`}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}

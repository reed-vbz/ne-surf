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

export default function Timeline({ steps, index, onChange, playing, onTogglePlay }: Props) {
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => onChangeRef.current((index + 1) % steps.length), 700);
    return () => clearInterval(id);
  }, [playing, index, steps.length]);

  const step = steps[index];
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/New_York" });
  const days = Array.from({ length: 8 }, (_, d) => d);
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/90 px-4 py-3 shadow-lg backdrop-blur">
      <button onClick={onTogglePlay} aria-label={playing ? "Pause" : "Play"}
        className="grid h-9 w-9 place-items-center rounded-full bg-slate-900 text-white">
        {playing ? "❚❚" : "▶"}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline justify-between text-xs text-slate-600">
          <span className="font-semibold text-slate-900">{step ? fmt.format(new Date(step.valid_time)) : "—"}</span>
          <span>+{step?.hour ?? 0} h</span>
        </div>
        <input type="range" min={0} max={Math.max(0, steps.length - 1)} value={index}
          onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-slate-900" aria-label="Forecast hour" />
        <div className="flex justify-between text-[10px] text-slate-500">
          {days.map((d) => <span key={d}>{steps[0] ? wd.format(new Date(Date.parse(steps[0].valid_time) + d * 86_400_000)) : `+${d}d`}</span>)}
        </div>
      </div>
    </div>
  );
}

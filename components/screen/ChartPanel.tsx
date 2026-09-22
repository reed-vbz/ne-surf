"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { dockCard } from "./OverviewScreen";

/** A native modal gives keyboard focus containment and Escape/return-focus behavior. */
export default function ChartPanel({ title, children }: { title: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
    else if (dialog.current?.open) { dialog.current.close(); trigger.current?.focus(); }
  }, [expanded]);
  return <>
    <div className="nesurf-chart-card" style={{ ...dockCard, position: "relative" }}>
      <button ref={trigger} aria-label={`Expand ${title}`} onClick={() => setExpanded(true)} className="nesurf-expand">↗</button>
      {!expanded && children}
    </div>
    <dialog ref={dialog} aria-label={title} onCancel={() => setExpanded(false)} onClose={() => setExpanded(false)} className="nesurf-chart-dialog">
      <button autoFocus aria-label={`Close ${title}`} onClick={() => setExpanded(false)} className="nesurf-expand">×</button>
      {expanded && children}
    </dialog>
  </>;
}

"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Dialog({ title, onClose, children, busy = false, className = "" }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className={`dialog ${className}`} aria-label={title} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="dialog-heading"><h2>{title}</h2><button type="button" className="icon-button" title="Close" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={19} /></button></div>
    {children}
  </dialog>;
}
"use client";
// Interactive components. Styles set from script go through the CSSOM (el.style.setProperty),
// which the CSP allows; no style attributes are ever rendered into HTML.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon } from "./icon";

// Card has its own module, so pages that only need a card don't load the rest of this one.
export { Card } from "./card";

/** ARIA tabs with arrow-key navigation (roving tabindex). */
export function Tabs({
  label,
  tabs,
}: {
  label: string;
  tabs: readonly { id: string; label: string; content: ReactNode }[];
}) {
  const [active, setActive] = useState(0);
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent) => {
    const n = tabs.length;
    const next =
      e.key === "ArrowRight"
        ? (active + 1) % n
        : e.key === "ArrowLeft"
          ? (active - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} onKeyDown={onKey}>
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            id={`${base}-tab-${t.id}`}
            aria-selected={i === active}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t, i) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          hidden={i !== active}
          tabIndex={0}
        >
          {t.content}
        </div>
      ))}
    </div>
  );
}

/** Native modal dialog: showModal() makes the rest of the page inert and traps focus. */
export function Modal({
  open,
  title,
  onClose,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-body">
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="modal-actions">
          {actions}
          <button type="button" className="btn btn-grey btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}

type ToastItem = { id: number; tone: "info" | "success" | "error"; text: string };
const ToastContext = createContext<(tone: ToastItem["tone"], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const push = useCallback((tone: ToastItem["tone"], text: string) => {
    const id = next.current++;
    setItems((xs) => [...xs.slice(-3), { id, tone, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 8000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <span>{t.text}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Shortens a long address for display; the copy button copies the full value. */
export function shortAddress(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function AddressText({ value, label = "address" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const short = useMemo(() => shortAddress(value), [value]);
  return (
    <span className="address">
      <span title={value}>{short}</span>
      <button
        type="button"
        aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={16} />
      </button>
    </span>
  );
}

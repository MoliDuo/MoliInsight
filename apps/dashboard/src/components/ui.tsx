import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import { Check, Copy, Loader2 } from "lucide-react";
import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { reason } from "@/lib/api";

// ---------------------------------------------------------------------------
// Buttons and fields

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md";
  busy?: boolean;
};

export function Button({ variant = "default", size = "md", busy, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
        variant === "default" && "border-border bg-card hover:bg-muted",
        variant === "primary" && "border-primary bg-primary text-primary-foreground hover:opacity-90",
        variant === "danger" && "border-border bg-card text-danger hover:bg-muted",
        variant === "ghost" && "border-transparent bg-transparent hover:bg-muted",
        className,
      )}
      {...rest}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
      {children}
    </button>
  );
}

const field = "h-8 rounded-md border border-border bg-card px-2.5 text-sm text-foreground placeholder:text-muted-foreground min-w-0";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(field, className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(field, "pr-7", className)} {...rest}>
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Layout

export function Card({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("rounded-lg border border-border bg-card", className)}>
      {title || action ? (
        <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
          <h3 className="text-sm font-semibold">{title}</h3>
          {action}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, intro, actions }: { title: ReactNode; intro?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {intro ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{intro}</p> : null}
      </div>
      {actions}
    </div>
  );
}

export function Stat({ label, value, delta, invert }: { label: string; value: ReactNode; delta?: number | null; invert?: boolean }) {
  const good = delta == null ? null : invert ? delta < 0 : delta > 0;
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold leading-tight">{value}</div>
      {delta != null && Number.isFinite(delta) ? (
        <div className={clsx("mt-0.5 text-xs", delta === 0 ? "text-muted-foreground" : good ? "text-primary" : "text-danger")}>
          {delta > 0 ? "▲" : delta < 0 ? "▼" : "–"} {Math.abs(delta * 100).toFixed(Math.abs(delta) < 0.1 ? 1 : 0)}% 比上一段
        </div>
      ) : null}
    </div>
  );
}

export function Note({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "muted" }) {
  return (
    <p className={clsx("my-2 rounded-md px-3 py-1.5 text-xs", tone === "warn" ? "bg-warn text-warn-foreground" : "bg-muted text-muted-foreground")}>
      {children}
    </p>
  );
}

export const Muted = ({ children, className }: { children: ReactNode; className?: string }) => (
  <p className={clsx("text-sm text-muted-foreground", className)}>{children}</p>
);

export const Code = ({ children }: { children: ReactNode }) => <code className="break-all">{children ?? "—"}</code>;

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

export function ErrorBlock({ error }: { error: unknown }) {
  return <p className="rounded-md border border-border bg-card px-4 py-3 text-sm text-danger">加载失败：{reason(error)}</p>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded-md bg-muted", className)} />;
}

export function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="加载中">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-20" />)}
      </div>
      <Skeleton className="h-56" />
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables

export function DataTable({ head, rows, empty = "这个范围内没有数据。" }: { head: ReactNode[]; rows: ReactNode[][]; empty?: ReactNode }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            {head.map((t, i) => <th key={i} className="whitespace-nowrap px-2 py-1.5 font-medium">{t}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/50">
              {cells.map((c, j) => <td key={j} className="px-2 py-1.5 align-top">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs

/** A confirmation that replaces `confirm()` and `prompt()`. With `phrase`, the user has to type it. */
export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel = "确认", phrase, onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  phrase?: string;
  onConfirm: () => Promise<unknown> | unknown;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
      setTyped("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) setTyped(""); onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-xl">
          <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-muted-foreground">{description}</Dialog.Description>
          {phrase ? (
            <div className="mt-3">
              <p className="mb-1 text-xs text-muted-foreground">输入 <code>{phrase}</code> 以确认</p>
              <Input className="w-full" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </div>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild><Button>取消</Button></Dialog.Close>
            <Button variant="danger" busy={busy} disabled={phrase !== undefined && typed !== phrase} onClick={run}>{confirmLabel}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Copying and secrets

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      } catch {}
    }}>
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {done ? "已复制" : label}
    </Button>
  );
}

/** A value that is shown once. */
export function SecretBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-warn px-4 py-3 text-warn-foreground">
      <div className="text-sm font-medium">{label}（只显示这一次，请现在保存）</div>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all">{value}</code>
        <CopyButton text={value} />
      </div>
    </div>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="relative rounded-md border border-border bg-muted">
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto px-3 pb-3 pt-1 text-xs leading-relaxed">{code}</pre>
    </div>
  );
}

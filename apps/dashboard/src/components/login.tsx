import { useState, type FormEvent } from "react";
import { ApiError, api } from "@/lib/api";
import { Button, Input } from "./ui";

export function LoginPage({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/login", "POST", { password });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 429 ? "尝试次数过多，请稍后再试" : e instanceof ApiError && e.status === 401 ? "口令不对" : "登录失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-7" />
          <h1 className="text-lg font-semibold tracking-tight">MoliInsight</h1>
        </div>
        <label className="mb-1 block text-xs text-muted-foreground" htmlFor="password">口令</label>
        <Input id="password" type="password" className="w-full" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        {error ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}
        <Button type="submit" variant="primary" busy={busy} className="mt-4 w-full">登录</Button>
      </form>
    </main>
  );
}

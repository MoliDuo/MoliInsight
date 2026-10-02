import { useNavigate } from "@tanstack/react-router";
import { Check, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ConnectGuide } from "@/components/connect";
import { Button, Card, Input, Muted, PageHeader, SecretBox } from "@/components/ui";
import { api, reason } from "@/lib/api";
import { fmt } from "@/lib/format";
import { useApi, useInvalidate, type AppRow } from "@/lib/hooks";

/** New app → key → setup code → waits for the first event. */
export function OnboardingPage() {
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ slug: string; key: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const apps = useApi<{ apps: AppRow[] }>("/api/apps", { refetchInterval: created ? 5000 : 0 });
  const mine = apps.data?.apps.find((a) => a.slug === created?.slug);
  const received = Boolean(mine?.lastEventAt);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/apps", "POST", { slug, name });
      const key = await api<{ key: string }>(`/api/apps/${slug}/keys`, "POST", { label: "default" });
      setCreated({ slug, key: key.key });
      await invalidate("/api/apps");
    } catch (e) {
      setError(reason(e) === "slug_taken" ? "这个 slug 已经有了" : reason(e) === "invalid_request" ? "slug 只能用小写字母、数字和 -，且不能是 new 或 settings" : `失败：${reason(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!created) {
    return (
      <>
        <PageHeader title="新建应用" intro="每个要统计的应用建一个。建好后会马上生成一把摄入密钥，并给出接入代码。" />
        <Card>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
            <label className="block text-xs text-muted-foreground">名称
              <Input required className="mt-1 block w-56" placeholder="如 Cashier" value={name} onChange={(e) => {
                setName(e.target.value);
                if (!slug || slug === autoSlug(name)) setSlug(autoSlug(e.target.value));
              }} />
            </label>
            <label className="block text-xs text-muted-foreground">slug（小写字母、数字、-）
              <Input required pattern="[a-z0-9\-]{1,40}" className="mt-1 block w-56" placeholder="cashier" value={slug} onChange={(e) => setSlug(e.target.value)} />
            </label>
            <Button type="submit" variant="primary" busy={busy}>创建并生成密钥</Button>
          </form>
          {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={`接入 ${name}`} intro="三步：保存密钥、把代码放进应用、等第一条数据到达。" />
      <div className="space-y-4">
        <SecretBox label="摄入密钥" value={created.key} />
        <ConnectGuide keyText={created.key} />
        <Card title="等待第一条事件">
          <div className="flex items-center gap-2">
            {received ? <Check className="size-4 text-primary" /> : <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            <span>{received ? `已收到第一条事件（${fmt(mine?.lastEventAt)}）` : "还没有收到。应用发出第一批数据后这里会自动更新。"}</span>
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => navigate({ to: "/$app/overview", params: { app: created.slug } })}>{received ? "去看数据" : "先去看看"}</Button>
            <Button onClick={() => navigate({ to: "/$app/settings", params: { app: created.slug } })}>应用设置</Button>
          </div>
          {received ? null : <Muted className="mt-3">以后随时可以回到「当前应用 → 接入」再看这段代码。</Muted>}
        </Card>
      </div>
    </>
  );
}

const autoSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

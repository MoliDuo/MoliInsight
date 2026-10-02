import { Card, CodeBlock, Muted } from "./ui";
import { snippets } from "@/lib/snippets";
import { useState } from "react";
import clsx from "clsx";

const TABS = [
  ["web", "Web / Next.js"],
  ["swift", "macOS / iOS（Swift）"],
  ["curl", "curl"],
] as const;

/** Setup code for the three ways an app sends data, with the address and key filled in. */
export function ConnectGuide({ keyText }: { keyText: string }) {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("web");
  const s = snippets(location.origin, keyText);
  return (
    <Card title="接入代码">
      <div className="mb-3 inline-flex rounded-md border border-border p-0.5" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={clsx("rounded px-2.5 py-1 text-xs", tab === id ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground")}>{label}</button>
        ))}
      </div>
      {tab === "web" ? (
        <div className="space-y-3">
          <Muted>浏览器里不放密钥：先在应用自己的后端加一个中继，浏览器把数据发给它，由它带着密钥转发。</Muted>
          <CodeBlock label="后端中继" code={s.relay} />
          <CodeBlock label="浏览器" code={s.browser} />
        </div>
      ) : null}
      {tab === "swift" ? (
        <div className="space-y-3">
          <Muted>没有后端的原生应用直接带密钥发送。密钥不要写进公开仓库，由 CI 注入或让用户在设置里填。</Muted>
          <CodeBlock label="Swift" code={s.swift} />
        </div>
      ) : null}
      {tab === "curl" ? (
        <div className="space-y-3">
          <Muted>用来确认密钥和地址是对的。</Muted>
          <CodeBlock label="shell" code={s.curl} />
        </div>
      ) : null}
    </Card>
  );
}

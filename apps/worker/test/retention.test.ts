import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRetention } from "../src/retention.ts";
import { createHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const DAY = 24 * 60 * 60 * 1000;

async function seed(slug: string, retentionDays: number, ages: number[]) {
  const now = h.clock.now;
  await h.env.DB.prepare("INSERT INTO apps (slug, name, retention_days, created_at) VALUES (?1, ?1, ?2, ?3)")
    .bind(slug, retentionDays, now)
    .run();
  const app = (await h.env.DB.prepare("SELECT id FROM apps WHERE slug = ?1").bind(slug).first<{ id: number }>())!;
  await h.env.DB.prepare(
    "INSERT INTO devices (app_id, device_id, platform, first_seen_at, last_seen_at) VALUES (?1, 'dev_retention1', 'web', ?2, ?2)",
  )
    .bind(app.id, now)
    .run();
  const device = (await h.env.DB.prepare("SELECT id FROM devices WHERE app_id = ?1").bind(app.id).first<{ id: number }>())!;
  for (const [i, age] of ages.entries()) {
    const at = now - age * DAY;
    await h.env.DB.prepare(
      `INSERT INTO events (app_id, event_id, device_ref, name, occurred_at, received_at, platform, release, props)
       VALUES (?1, ?2, ?3, 'e', ?4, ?4, 'web', 'r1', '{}')`,
    )
      .bind(app.id, `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, device.id, at)
      .run();
  }
  return app.id;
}

const events = async (appId: number) =>
  (await h.env.DB.prepare("SELECT count(*) AS n FROM events WHERE app_id = ?1").bind(appId).first<{ n: number }>())!.n;

describe("retention", () => {
  it("deletes only what is past each app's own retention", async () => {
    const short = await seed("short", 7, [1, 6, 8, 40]);
    const long = await seed("long", 90, [1, 40, 89, 91]);
    const result = await runRetention(h.env.DB, h.clock.now);
    expect(result).toMatchObject({ eventsDeleted: 3, more: false });
    expect(await events(short)).toBe(2);
    expect(await events(long)).toBe(3);
  });

  it("works through a backlog in batches and says when it stopped early", async () => {
    // The other tests' apps use up part of a run's budget, so this one starts clean.
    const saved = h;
    h = await createHarness();
    const id = await seed("backlog", 1, [5, 5, 5, 5, 5, 5, 5]);
    const first = await runRetention(h.env.DB, h.clock.now, { batchSize: 2, maxBatches: 2 });
    expect(first.more).toBe(true);
    expect(first.eventsDeleted).toBe(4);
    const rest = await runRetention(h.env.DB, h.clock.now, { batchSize: 2, maxBatches: 10 });
    expect(rest.more).toBe(false);
    expect(await events(id)).toBe(0);
    await h.close();
    h = saved;
  });

  it("clears login failures older than a day", async () => {
    await h.env.DB.prepare("INSERT INTO login_failures (at) VALUES (?1), (?2)")
      .bind(h.clock.now - 2 * DAY, h.clock.now - 1000)
      .run();
    await runRetention(h.env.DB, h.clock.now);
    const row = await h.env.DB.prepare("SELECT count(*) AS n FROM login_failures").first<{ n: number }>();
    expect(row!.n).toBe(1);
  });
});

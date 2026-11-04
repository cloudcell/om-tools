import { EngineClient } from "./engineClient";

async function main() {
  const ep = { kind: "tcp" as const, host: "127.0.0.1", port: 17391 };
  const c = new EngineClient(ep);
  await c.connect();
  console.log("connected, ping:", await c.ping());
  const sid = await c.openSession("repl");
  console.log("session:", sid);
  const ws = await c.query("workspace_summary");
  console.log("views:", ws?.view_ids?.length, "cubes:", ws?.cube_ids?.length);
  const dl = await c.query("dimension_list");
  console.log("dims:", dl.dimensions.length);
  const r = await c.send("create_dimension", { name: "SelfTestDim", dim_type: "set" });
  console.log("create_dimension ok:", r.ok, r.error || "");
  await c.query("dimension_list");
  console.log("SELFTEST OK");
  c.close();
  process.exit(0);
}
main().catch((e) => { console.error("SELFTEST FAIL", e); process.exit(1); });

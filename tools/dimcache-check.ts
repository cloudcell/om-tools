/* Stale-dimCache regression (stacked axes rendered raw item_ids).
 * An external client (MCP agent, second GUI) mutates dims; the webview only
 * re-runs refreshModel on event.dimension.* — which must refetch, not serve
 * the cached detail forever. Run: esbuild --bundle --platform=node + node.
 */
import { Store } from "../webview/state";

// Minimal shims: state.ts touches DOM only in dialogs/setOptions paths.
(globalThis as any).document ??= { dispatchEvent() {}, createElement: () => ({}) };
(globalThis as any).CustomEvent ??= class CustomEvent { constructor(public type: string, public init?: any) {} };

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string) => { if (cond) { pass++; console.log("ok", name); } else { fail++; console.log("FAIL", name); } };

const names = (store: Store, id: string) => store.dimItems(id).map((i) => i.name).join(",");

async function main() {
  // Simulated runtime: "FM Scenario" starts with one item; an agent adds more later.
  const dimItems: { id: string; name: string }[] = [{ id: "item_a", name: "Base" }];
  const api: any = {
    loadUiState: () => null,
    updateUiState: () => {},
    dimensionList: async () => ({ dimensions: [{ id: "d1", name: "FM Scenario", items: dimItems.length, item_list: dimItems.map((i) => ({ ...i })) }] }),
    cubeList: async () => ({ cubes: [] }),
    viewList: async () => ({ views: [] }),
    workspaceSummary: async () => ({}),
    dimensionDetail: async () => ({ id: "d1", name: "FM Scenario", items: dimItems.map((i) => ({ ...i })), outline: [] }),
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  const store = new Store(api);
  await store.refreshModel(); await tick();
  ok(names(store, "d1") === "Base", "initial dim cached (1 item)");

  // External mutation, no GUI path: agent appends items; event.dimension.* -> refreshModel.
  dimItems.push({ id: "item_b", name: "Bull" }, { id: "item_c", name: "Bear" });
  await store.refreshModel(); await tick();
  ok(names(store, "d1") === "Base,Bull,Bear", "external item add refetched (count change)");

  // Same-count replacement (delete + recreate) must also heal — item_list ids differ.
  dimItems.splice(1, 1, { id: "item_d", name: "Bull" });
  await store.refreshModel(); await tick();
  ok(store.dimItems("d1")[1].id === "item_d", "same-count id replacement refetched");

  // Item rename heals too.
  dimItems[2].name = "Bear v2";
  await store.refreshModel(); await tick();
  ok(names(store, "d1") === "Base,Bull,Bear v2", "item rename refetched");

  // No change -> no refetch (cache must not churn on every refreshModel).
  let detailCalls = 0;
  const orig = api.dimensionDetail;
  api.dimensionDetail = async (...a: any[]) => { detailCalls++; return orig(...a); };
  await store.refreshModel(); await tick();
  ok(detailCalls === 0, "unchanged dim not refetched");

  // invalidateDimCache (event.dimension.* path) forces refetch even when list matches.
  store.invalidateDimCache();
  await store.refreshModel(); await tick();
  ok(detailCalls === 1 && names(store, "d1") === "Base,Bull,Bear v2", "invalidateDimCache forces refetch");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

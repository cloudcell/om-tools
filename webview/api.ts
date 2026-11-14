import { Transport } from "./transport";
import type { PickFileParams, UiState } from "../shared/messages";

/** Typed OM Core API client. Wraps the query/command vocabulary exposed by the
 *  om-core runtime (see lib_command/core/query_service.py + bootstrap.py).
 *  All methods return plain JSON data (DTOs) — never engine objects. */

export interface DimSummary { id: string; name: string; items: number; item_list?: { id: string; name: string }[] }
export interface CubeSummary { id: string; name: string; dimensions: number }
export interface ViewSummary { id: string; name: string }
export interface DimDetail { id: string; name: string; items: { id: string; name: string }[]; outline?: any[] }
export interface ViewDetail {
  id: string; name: string; cube_id: string;
  row_dim_ids: string[]; col_dim_ids: string[]; page_dim_ids: string[];
  layout: { rows: string[]; cols: string[]; page: string[] };
}
export interface CellExplain { source: string; rule_body: string | null; error: string | null; depends: any }
export interface CellDTO {
  view_id: string; cube_id: string;
  row_key: string[]; col_key: string[]; addr: string[];
  value: any; display_value: string; kind: string; explain: CellExplain;
}
export interface CellRangeDTO {
  view_id: string; cube_id: string;
  row_start: number; col_start: number; row_end: number; col_end: number;
  cells: CellDTO[]; row_keys: string[][]; col_keys: string[][];
}
export interface RuleDTO {
  id: string; cube_id: string; expression: string;
  targets: any[]; addr_mask: any[]; specificity?: number; is_anchored?: boolean;
}
export interface WorkspaceRules { type: string; rules: RuleDTO[]; rule_order?: string[]; cube_ids?: string[] }
export interface WorkspaceSummary {
  saved_default_view_id?: string | null;
  view_ids?: string[]; cube_ids?: string[]; dimension_ids?: string[];
}
export interface SelectionStats { sum?: number; avg?: number; count?: number; [k: string]: any }

export class OmApi {
  constructor(private t: Transport) {}

  ping() { return this.t.request("ping"); }
  reconnect() { return this.t.request("reconnect"); }
  startRuntime() { return this.t.request("startRuntime"); }
  stopRuntime() { return this.t.request("stopRuntime"); }
  /** Native Open/Save dialog in the host (VS Code only, see AppConfig.nativeFileDialogs). */
  pickFile(params: PickFileParams): Promise<{ path: string | null }> { return this.t.request("pickFile", params as any); }
  /** Editor tab title in VS Code (`panel.title`); a no-op in the bridge, where `document.title` is the tab title. */
  setTitle(title: string) { return this.t.request("setTitle", { title }); }
  /** Saved panel sizes etc. (T-045): synchronous, null when nothing is saved. */
  loadUiState(): UiState | null { return this.t.loadUiState(); }
  saveUiState(state: UiState): void { this.t.saveUiState(state); }
  /** Saves only the given fields and keeps the rest (layout and theme are written by different code and
   *  must not wipe each other: `saveUiState` replaces the whole state). */
  updateUiState(patch: Partial<UiState>): void { this.t.saveUiState({ ...(this.t.loadUiState() || {}), ...patch }); }

  // ---- queries ----
  workspaceSummary(): Promise<WorkspaceSummary> { return this.t.request("query", { query_id: "workspace_summary" }); }
  dimensionList(): Promise<{ dimensions: DimSummary[] }> { return this.t.request("query", { query_id: "dimension_list" }); }
  cubeList(): Promise<{ cubes: CubeSummary[] }> { return this.t.request("query", { query_id: "cube_list" }); }
  viewList(): Promise<{ views: ViewSummary[] }> { return this.t.request("query", { query_id: "view_list" }); }
  dimensionDetail(dimId: string): Promise<DimDetail> { return this.t.request("query", { query_id: "dimension_detail", params: { dim_id: dimId } }); }
  cubeDetail(cubeId: string): Promise<any> { return this.t.request("query", { query_id: "cube_detail", params: { cube_id: cubeId } }); }
  viewDetail(viewId: string): Promise<ViewDetail> { return this.t.request("query", { query_id: "view_detail", params: { view_id: viewId } }); }
  viewRowKeys(viewId: string): Promise<{ keys: string[][] }> { return this.t.request("query", { query_id: "view_row_keys", params: { view_id: viewId } }); }
  viewColKeys(viewId: string): Promise<{ keys: string[][] }> { return this.t.request("query", { query_id: "view_col_keys", params: { view_id: viewId } }); }
  viewRowHeader(viewId: string, section: number): Promise<{ header: string }> { return this.t.request("query", { query_id: "view_row_header", params: { view_id: viewId, section } }); }
  viewColHeader(viewId: string, section: number): Promise<{ header: string }> { return this.t.request("query", { query_id: "view_col_header", params: { view_id: viewId, section } }); }
  cellRange(viewId: string, rowKeys: string[][], colKeys: string[][]): Promise<CellRangeDTO> {
    return this.t.request("query", { query_id: "cell_range", params: { view_id: viewId, row_keys: rowKeys, col_keys: colKeys } });
  }
  cellDetail(viewId: string, rowKey: string[], colKey: string[]): Promise<CellDTO> {
    return this.t.request("query", { query_id: "cell_detail", params: { view_id: viewId, row_key: rowKey, col_key: colKey } });
  }
  workspaceRules(): Promise<WorkspaceRules> { return this.t.request("query", { query_id: "workspace_rules" }); }
  cubeRuleCounts(cubeId: string): Promise<{ cell_rules: number; rules: number }> { return this.t.request("query", { query_id: "cube_rule_counts", params: { cube_id: cubeId } }); }
  selectionStats(params: any = {}): Promise<SelectionStats> { return this.t.request("query", { query_id: "selection_stats", params }); }
  outlineTree(dimId: string): Promise<any> { return this.t.request("query", { query_id: "outline_tree", params: { dim_id: dimId } }); }
  timelineSnapshots(): Promise<any> { return this.t.request("query", { query_id: "timeline_snapshots" }); }

  // ---- commands ----
  createDimension(name: string, dimType = "set") { return this.t.request("command", { command_id: "create_dimension", params: { name, dim_type: dimType } }); }
  createDimensionItem(dimId: string, name: string, position: "append" | "prepend" = "append") { return this.t.request("command", { command_id: "create_dimension_item", params: { dim_id: dimId, name, position } }); }
  /** Qt Delete Dimension warning: hard-number cells and rules that go with the dimension. */
  dimensionDeletionImpact(dimId: string, itemIds: string[]): Promise<{ total_data_cells: number; anchored_rules: number; rules: number }> { return this.t.request("query", { query_id: "dimension_deletion_impact", params: { dim_id: dimId, item_ids: itemIds } }); }
  createCube(name: string, dimensionIds: string[]) { return this.t.request("command", { command_id: "create_cube", params: { name, dimension_ids: dimensionIds } }); }
  createView(name: string, cubeId: string, rowDims: string[], colDims: string[], pageDims?: string[]) {
    const params: Record<string, any> = { name, cube_id: cubeId, row_dims: rowDims, col_dims: colDims };
    if (pageDims) params.page_dim_ids = pageDims;
    return this.t.request("command", { command_id: "create_view", params });
  }
  setCellHardvalueByAddr(cubeId: string, addr: string[], value: any) { return this.t.request("command", { command_id: "set_cell_hardvalue_by_addr", params: { cube_id: cubeId, addr, value } }); }
  setCellHardvaluesBatchByAddr(cubeId: string, entries: { addr: string[]; value: any }[]) { return this.t.request("command", { command_id: "set_cell_hardvalues_batch_by_addr", params: { cube_id: cubeId, entries } }); }
  setRule(cubeId: string, targets: any[], expression: string, isAnchored = false) { return this.t.request("command", { command_id: "set_rule", params: { cube_id: cubeId, targets, expression, is_anchored: isAnchored } }); }
  deleteRule(ruleId: string) { return this.t.request("command", { command_id: "delete_rule", params: { rule_id: ruleId } }); }
  recalc(scope = "all") { return this.t.request("command", { command_id: "run_recalculation", params: { scope } }); }
  setActiveView(viewId: string) { return this.t.request("command", { command_id: "set_active_view", params: { view_id: viewId } }); }
  moveViewDimension(viewId: string, dimId: string, dest: "row" | "col" | "page", index?: number) {
    return this.t.request("command", { command_id: "move_view_dimension", params: { view_id: viewId, dim_id: dimId, dest, index: index ?? null } });
  }
  setViewAxes(viewId: string, rowDimId: string, colDimId: string) { return this.t.request("command", { command_id: "set_view_axes", params: { view_id: viewId, row_dimension_id: rowDimId, col_dimension_id: colDimId } }); }
  setPageItemId(viewId: string, dimId: string, itemId: string) { return this.t.request("command", { command_id: "set_page_item_id", params: { view_id: viewId, dim_id: dimId, item_id: itemId } }); }
  /** Selected page item for ONE page dimension of a view. Runtime requires both ids;
   *  returns { type: "page_selection", view_id, dim_id, item_id: string | null }. */
  pageSelection(viewId: string, dimId: string): Promise<{ dim_id: string; item_id: string | null }> {
    return this.t.request("query", { query_id: "page_selection", params: { view_id: viewId, dim_id: dimId } });
  }
  checkpoint(description: string, parentId?: string, branch?: string) { return this.t.request("command", { command_id: "create_checkpoint", params: { description, parent_id: parentId ?? null, branch: branch ?? null } }); }
  restoreCheckpoint(snapshotId: string) { return this.t.request("command", { command_id: "restore_checkpoint", params: { snapshot_id: snapshotId } }); }
  renameCheckpoint(checkpointId: string, description: string) { return this.t.request("command", { command_id: "rename_checkpoint", params: { checkpoint_id: checkpointId, description } }); }
  deleteCheckpoint(checkpointId: string) { return this.t.request("command", { command_id: "delete_checkpoint", params: { checkpoint_id: checkpointId } }); }
  saveWorkspace(path?: string) { return this.t.request("command", { command_id: "save_workspace", params: { path: path || null } }); }
  loadWorkspace(path: string) { return this.t.request("command", { command_id: "load_workspace", params: { path } }); }
  createNewWorkspace(engineType = "python") { return this.t.request("command", { command_id: "create_new_workspace", params: { engine_type: engineType } }); }
  undo() { return this.t.request("command", { command_id: "undo", params: {} }); }
  redo() { return this.t.request("command", { command_id: "redo", params: {} }); }
  undoState(): Promise<{ can_undo: boolean; can_redo: boolean; undo_description?: string; redo_description?: string }> { return this.t.request("query", { query_id: "undo_state" }); }
  setProperty(target: string, property: string, value: any) { return this.t.request("command", { command_id: "set_property", params: { target, property, value } }); }
  formatBold(target = "selection", value = true) { return this.setProperty(target, "format.bold", value); }
  formatItalic(target = "selection", value = true) { return this.setProperty(target, "format.italic", value); }
  formatUnderline(target = "selection", value = true) { return this.setProperty(target, "format.underline", value); }
  formatColor(target = "selection", value: string) { return this.setProperty(target, "format.color", value); }
  formatBgColor(target = "selection", value: string) { return this.setProperty(target, "format.bg_color", value); }
  formatFontSize(target = "selection", value: number) { return this.setProperty(target, "format.font_size", value); }
  formatNumberFormat(target = "selection", value: string) { return this.setProperty(target, "format.number_format", value); }
  renameDimension(dimId: string, newName: string) { return this.t.request("command", { command_id: "rename_dimension", params: { dim_id: dimId, new_name: newName } }); }
  renameDimensionItem(dimId: string, itemId: string, newName: string) { return this.t.request("command", { command_id: "rename_dimension_item", params: { dim_id: dimId, item_id: itemId, new_name: newName } }); }
  renameCube(cubeId: string, newName: string) { return this.t.request("command", { command_id: "rename_cube", params: { cube_id: cubeId, new_name: newName } }); }
  renameView(viewId: string, newName: string) { return this.t.request("command", { command_id: "rename_view", params: { view_id: viewId, new_name: newName } }); }
  deleteView(viewId: string) { return this.t.request("command", { command_id: "delete_view", params: { view_id: viewId } }); }
  deleteDimension(dimId: string) { return this.t.request("command", { command_id: "delete_dimension", params: { dim_id: dimId } }); }
  deleteCube(cubeId: string) { return this.t.request("command", { command_id: "delete_cube", params: { cube_id: cubeId } }); }
  deleteDimensionItems(dimId: string, itemIds: string[]) { return this.t.request("command", { command_id: "delete_dimension_items", params: { dim_id: dimId, item_ids: itemIds } }); }
  attachDimensionToCube(cubeId: string, dimId: string, defaultItemId?: string) { return this.t.request("command", { command_id: "attach_dimension_to_cube", params: { cube_id: cubeId, dim_id: dimId, default_item_id: defaultItemId ?? null } }); }
  detachDimensionFromCube(cubeId: string, dimId: string) { return this.t.request("command", { command_id: "detach_dimension_from_cube", params: { cube_id: cubeId, dim_id: dimId } }); }
  setViewLayout(viewId: string, layout: { rows: string[]; cols: string[]; page: string[] }) { return this.t.request("command", { command_id: "set_view_layout", params: { view_id: viewId, layout } }); }
  setCellHardvalue(viewId: string, cellRef: any, value: any) { return this.t.request("command", { command_id: "set_cell_hardvalue", params: { view_id: viewId, cell_ref: cellRef, value } }); }
  clearCellHardvalue(viewId: string, cellRef: any) { return this.t.request("command", { command_id: "clear_cell_hardvalue", params: { view_id: viewId, cell_ref: cellRef } }); }
  setRuleAnchored(viewId: string, cellRef: any, expression: string) { return this.t.request("command", { command_id: "set_rule_anchored", params: { view_id: viewId, cell_ref: cellRef, expression } }); }
  deleteRuleAnchored(viewId: string, cellRef: any) { return this.t.request("command", { command_id: "delete_rule_anchored", params: { view_id: viewId, cell_ref: cellRef } }); }
  updateRule(ruleId: string, targets: any[], expression: string, isAnchored = false) { return this.t.request("command", { command_id: "update_rule", params: { rule_id: ruleId, targets, expression, is_anchored: isAnchored } }); }
  setRuleOrder(ruleIds: string[]) { return this.t.request("command", { command_id: "set_rule_order", params: { rule_ids: ruleIds } }); }
  setSelection(row: number, col: number, mode = "cell", anchorRow?: number, anchorCol?: number, selectedIndices?: any[], viewId?: string) { return this.t.request("command", { command_id: "set_selection", params: { row, col, mode, anchor_row: anchorRow ?? null, anchor_col: anchorCol ?? null, selected_indices: selectedIndices ?? [], view_id: viewId ?? null } }); }
  moveSelection(direction: string, amount = 1, viewId?: string) { return this.t.request("command", { command_id: "move_selection", params: { direction, amount, view_id: viewId ?? null } }); }
  setEngine(engineType: string, dependencyTracking = true) { return this.t.request("command", { command_id: "set_engine", params: { engine_type: engineType, dependency_tracking: dependencyTracking } }); }
  setDependencyTracking(enabled: boolean) { return this.t.request("command", { command_id: "set_dependency_tracking", params: { enabled } }); }
  setMultithreadRecompute(enabled: boolean) { return this.t.request("command", { command_id: "set_multithread_recompute", params: { enabled } }); }
  clearProfilerSnapshot() { return this.t.request("command", { command_id: "clear_profiler_snapshot", params: {} }); }
  clearCache(scope = "all") { return this.t.request("command", { command_id: "clear_cache", params: { scope } }); }
  cancelOperation() { return this.t.request("command", { command_id: "cancel_operation", params: {} }); }
  setDimensionItemOrder(dimId: string, itemIds: string[]) { return this.t.request("command", { command_id: "set_dimension_item_order", params: { dim_id: dimId, item_ids: itemIds } }); }
  setDimensionOutline(dimId: string, outline: any[] | null) { return this.t.request("command", { command_id: "set_dimension_outline", params: { dim_id: dimId, outline } }); }
  clearDimensionOutline(dimId: string) { return this.t.request("command", { command_id: "clear_dimension_outline", params: { dim_id: dimId } }); }
  createGroup(dimId: string, label: string, parentGroupId?: string) { return this.t.request("command", { command_id: "create_group", params: { dim_id: dimId, label, parent_group_id: parentGroupId ?? null } }); }
  deleteGroup(dimId: string, groupNodeId: string, cascade = true) { return this.t.request("command", { command_id: "delete_group", params: { dim_id: dimId, group_node_id: groupNodeId, cascade } }); }
  deleteGroupNode(dimId: string, nodeId: string) { return this.t.request("command", { command_id: "delete_group_node", params: { dim_id: dimId, node_id: nodeId, promote_children: "to_parent" } }); }
  moveItemsToGroup(dimId: string, itemIds: string[], groupNodeId?: string) { return this.t.request("command", { command_id: "move_items_to_group", params: { dim_id: dimId, item_ids: itemIds, group_node_id: groupNodeId ?? null } }); }
  ungroupItems(dimId: string, itemIds: string[]) { return this.t.request("command", { command_id: "ungroup_items", params: { dim_id: dimId, item_ids: itemIds } }); }
  renameGroupNode(dimId: string, nodeId: string, newLabel: string) { return this.t.request("command", { command_id: "rename_group_node", params: { dim_id: dimId, node_id: nodeId, new_label: newLabel } }); }
  moveNodes(dimId: string, nodeIds: string[], parentNodeId: string | null, anchorNodeId?: string | null, position = "after", moveEmptyParents = false) { return this.t.request("command", { command_id: "move_nodes", params: { dim_id: dimId, node_ids: nodeIds, parent_node_id: parentNodeId, anchor_node_id: anchorNodeId ?? null, position, move_empty_parents: moveEmptyParents } }); }
  placeItemNodes(dimId: string, itemIds: string[], parentNodeId: string | null, anchorNodeId?: string | null, position = "after") { return this.t.request("command", { command_id: "place_item_nodes", params: { dim_id: dimId, item_ids: itemIds, parent_node_id: parentNodeId, anchor_node_id: anchorNodeId ?? null, position } }); }
  createAggregateItem(dimId: string, groupNodeId: string, name: string) { return this.t.request("command", { command_id: "create_aggregate_item", params: { dim_id: dimId, group_node_id: groupNodeId, name } }); }
  ensureGroupInGraph(dimId: string, label: string, children: any[], parentGroupId?: string) { return this.t.request("command", { command_id: "ensure_group_in_graph", params: { dim_id: dimId, label, children, parent_group_id: parentGroupId ?? null } }); }
  createDimensionItemsBatch(entries: { dim_id: string; name: string; position?: string }[]) { return this.t.request("command", { command_id: "create_dimension_items_batch", params: { entries } }); }
  setRangeValues(viewId: string, top: number, left: number, values: any[][]) { return this.t.request("command", { command_id: "set_range_values", params: { view_id: viewId, top, left, values } }); }
  runExcelImport(path: string) { return this.t.request("command", { command_id: "run_excel_import", params: { path } }); }
  setViewColWidth(viewId: string, colIndex: number, width: number) { return this.t.request("command", { command_id: "set_view_col_width", params: { view_id: viewId, col_index: colIndex, width } }); }
  setViewRowHeaderWidth(viewId: string, depthOrIndex: number, width: number) { return this.t.request("command", { command_id: "set_view_row_header_width", params: { view_id: viewId, depth_or_index: depthOrIndex, width } }); }

  // ---- diagnostics queries ----
  diagnosticsCalculationFlow(cubeId: string, addr: string[], maxDepth?: number): Promise<any> { return this.t.request("query", { query_id: "diagnostics_calculation_flow", params: { cube_id: cubeId, addr, max_depth: maxDepth } }); }
  diagnosticsCircularReferences(cubeId: string, addr: string[], maxDepth?: number): Promise<any> { return this.t.request("query", { query_id: "diagnostics_circular_references", params: { cube_id: cubeId, addr, max_depth: maxDepth } }); }
  diagnosticsDependencyMetrics(): Promise<any> { return this.t.request("query", { query_id: "diagnostics_dependency_metrics" }); }
  diagnosticsDependencyTrackingState(): Promise<{ dependency_tracking_enabled: boolean }> { return this.t.request("query", { query_id: "diagnostics_dependency_tracking_state" }); }
  diagnosticsMultithreadConfig(): Promise<any> { return this.t.request("query", { query_id: "diagnostics_multithread_config" }); }
  diagnosticsEngineBackend(): Promise<any> { return this.t.request("query", { query_id: "diagnostics_engine_backend" }); }
  diagnosticsRuleEvalProfile(topN = 10): Promise<any> { return this.t.request("query", { query_id: "diagnostics_rule_eval_profile", params: { top_n: topN } }); }
  diagnosticsDirtyCount(includeKeys = false): Promise<{ dirty_count: number }> { return this.t.request("query", { query_id: "diagnostics_dirty_count", params: { include_keys: includeKeys } }); }
  ruleTargetResolve(cubeId: string, lhs: string): Promise<any> { return this.t.request("query", { query_id: "rule_target_resolve", params: { cube_id: cubeId, lhs } }); }
  cellRule(cubeId: string, addr: string[]): Promise<{ expression: string | null }> { return this.t.request("query", { query_id: "cell_rule", params: { cube_id: cubeId, addr } }); }
  ruleDetail(cubeId: string, addr: string[]): Promise<{ expression: string | null }> { return this.t.request("query", { query_id: "rule_detail", params: { cube_id: cubeId, addr } }); }
  cubeDetachImpact(cubeId: string, dimId: string): Promise<any> { return this.t.request("query", { query_id: "cube_detach_impact", params: { cube_id: cubeId, dim_id: dimId } }); }
  outlineTreeView(viewId: string, axis: string): Promise<any> { return this.t.request("query", { query_id: "outline_tree", params: { view_id: viewId, axis } }); }
  selectionCurrent(): Promise<any> { return this.t.request("query", { query_id: "selection_current" }); }
  activeViewCurrent(): Promise<{ view_id: string; view_name?: string }> { return this.t.request("query", { query_id: "active_view_current" }); }
  cellChannelValues(viewId: string, rowKey: string[], colKey: string[], pageSelections: any, channels: string[]): Promise<any> { return this.t.request("query", { query_id: "cell_channel_values", params: { view_id: viewId, row_key: rowKey, col_key: colKey, page_selections: pageSelections, channels } }); }
  gridViewportSnapshot(viewId: string, rowKeys: string[][], colKeys: string[][], pageSelections: any, channels?: string[]): Promise<any> { return this.t.request("query", { query_id: "grid_viewport_snapshot", params: { view_id: viewId, row_keys: rowKeys, col_keys: colKeys, page_selections: pageSelections, channels: channels ?? null } }); }
  dimensionEffectiveOrder(dimId: string): Promise<{ item_ids: string[] }> { return this.t.request("query", { query_id: "dimension_effective_order", params: { dim_id: dimId } }); }

  subscribe(topic: string, cb: (env: any) => void) { this.t.subscribe(topic, cb); }
}

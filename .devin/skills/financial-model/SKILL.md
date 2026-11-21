---
name: financial-model
description: Build, rebuild, or repair integrated financial models in OM Core using separate statement cubes, explicit formulas, scenarios, DCF valuation, checks, and no wildcard cube mapping unless the user explicitly requests it.
---

# Financial Model Skill

Use this skill for requests to create, rebuild, repair, extend, or explain an OM
Core financial model. It is mandatory for requests involving a profit and loss
statement, balance sheet, cash flow statement, forecast, scenario analysis,
valuation, DCF, or three-statement model.

## Required model architecture

Create separate cubes and views for each major output:

- `ProfitLoss`
- `BalanceSheet`
- `CashFlowStatement`
- `DCFValuation`
- `Checks`

Do not combine PL, BS, CFS, and valuation in one cube. Do not add a statement
dimension merely to merge statements into one cube.

Use separate line-item dimensions for each statement:

- `ProfitLossItem`
- `BalanceSheetItem`
- `CashFlowItem`
- `DCFMetric`
- `CheckMetric`

Always include:

- a sequential `Year` dimension
- a set-valued `Scenario` dimension
- at least `Base`, `Upside`, and `Downside` scenarios unless the user explicitly
  asks for fewer scenarios
- 2024A and 2025A actual periods unless the user specifies a different history
- forecast periods beginning in 2026E unless the user specifies a different
  forecast start

## Naming rules

Use names without spaces in dimensions, dimension items, cubes, and views.
Examples:

- `ProfitLoss`
- `CashFlowStatement`
- `AccountsReceivable`
- `TotalLiabilitiesAndEquity`

Do not retain a space-containing name by assuming OM Core will display it
nicely. Rename or recreate objects before finalizing.

## Mandatory wildcard rule

Never use `*.*`, whole-cube wildcard references, or wildcard cross-cube mapping
unless the user explicitly asks for wildcard behavior.

Examples to avoid unless explicitly requested:

- `ProfitLoss::*.*`
- `*.*`
- wildcard whole-cube mapping

Use explicit dimensions and item names in targets and expressions:

```text
ProfitLossItem.COGS = ProfitLossItem.Revenue * 0.60
```

When targeting only one scenario, include `Scenario.ScenarioName`.

## Rebuilding existing models

Before rebuilding or replacing a model:

1. Query cubes, views, dimensions, rules, and workspace summary.
2. Delete the target model's cubes, views, rules, and custom dimensions that
   belong only to that model.
3. Delete stale rules before deleting a cube or dimension.
4. Verify each deleted cube/view no longer appears in workspace queries.
5. Recreate clean objects with space-free names.

Never delete unrelated cubes or dimensions.

## OM Core command gotchas

- `create_dimension` requires `dim_type` as `"set"` or `"seq"`.
- `create_dimension_item` requires `dim_id`, `name`, and `position`.
- `create_cube` requires `dimension_ids`.
- `create_view` requires `row_dims` and `col_dims`.
- `set_rule` requires `is_anchored` as a boolean.
- Rule targets use `[dimension_name, item_name]` pairs.
- `set_cell_hardvalue_by_addr` addresses start with `at_value`, followed by
  item IDs in cube dimension order.
- `run_recalculation` requires `scope`, normally `"all"`.
- `delete_rule` requires only `rule_id`.
- Rule expressions use dimension names and dot notation, for example
  `ProfitLossItem.Revenue`.

Use `cell_range` only after reading the view's `view_row_keys` and
`view_col_keys`.

## Build sequence

1. Clarify missing requirements only if they materially change the model.
   Reasonable defaults are Base/Upside/Downside, 2024A–2025A actuals,
   2026E–2030E forecast, and DCF valuation.
2. Discover existing workspace objects before creating anything.
3. Create years, scenarios, statement line-item dimensions, DCF metrics, and
   check metrics.
4. Create four statement/valuation cubes and a checks cube.
5. Create one view for each cube.
6. Enter only actual and assumption hardcodes.
7. Add explicit formulas for totals and derived values.
8. Link statements with cross-cube formulas only where necessary and explicitly
   named.
9. Run recalculation.
10. Verify every output with `cell_range`.
11. Add or update checks to prove ties and roll-forwards.
12. Recalculate again after any fix.

## Formula integrity

Every statement-specific formula must live in that statement's own cube.

For a standard three-statement model:

### ProfitLoss

- COGS
- GrossProfit
- OperatingExpenses
- EBITDA
- DA
- EBIT
- InterestExpense
- PreTaxIncome
- Taxes
- NetIncome

### BalanceSheet

- Cash
- AccountsReceivable
- Inventory
- NetPPE
- TotalAssets
- AccountsPayable
- Debt
- TotalLiabilities
- ShareholdersEquity
- TotalLiabilitiesAndEquity

### CashFlowStatement

- NetIncome
- DA
- ChangeInNWC
- CashFromOperations
- CapitalExpenditures
- CashFromInvesting
- DebtRepayment
- Dividends
- CashFromFinancing
- NetChangeInCash
- BeginningCash
- EndingCash
- UFCF

### DCFValuation

- WACC
- TerminalGrowth
- PVOfUFCF
- PVOfTerminalValue
- EnterpriseValue
- Debt
- Cash
- EquityValue
- DownsideEV
- BaseEV
- UpsideEV

Do not claim a statement is linked or reconciled unless the relevant values were
actually queried and verified.

## Checks cube

The `Checks` cube must include at least:

- `BalanceSheetCheck`
- `CashFlowCheck`
- `NoModelErrors`
- `ValuationCheck`

Use `0` to represent a pass.

Checks should verify:

- `TotalAssets - TotalLiabilitiesAndEquity = 0`
- CFS ending cash agrees with the BS cash balance
- no `#REF`, `#CIRC`, `#DIV0`, `#EXPR`, or `#ERROR` output
- DCF equity value is consistent with enterprise value less debt plus cash

Checks are formulas or hardcodes only after the underlying statements are
verified. Never return "PASS" while leaving hardcoded or unchecked values.

## Verification

Before finishing:

- Query `cube_list` and `view_list`.
- Confirm all five cubes exist.
- Recalculate with `scope: "all"`.
- Read representative and 2030E cells from every view.
- Search returned values for kinds or display values containing `#`.
- Verify the BS assets equal liabilities and equity for every scenario/year.
- Verify CFS beginning cash plus net change in cash equals ending cash.
- Verify UFCF is derived from EBIT, taxes, D&A, capital expenditures, and NWC.
- Verify DCF enterprise and equity values reconcile.

Do not describe the model as complete, correct, or fixed if recalculation
completes but the cells have errors or the statements do not tie.

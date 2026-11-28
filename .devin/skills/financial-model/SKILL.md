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

## Slice-first rule construction

OM Core is a multidimensional rule engine, not a spreadsheet. Express one
calculation once over the broadest valid slice instead of repeating it for
every year or scenario.

Prefer compact slice targets by omitting dimensions that should vary freely:

```text
rule ProfitLoss::ProfitLossItem.COGS =
  ProfitLoss::[ProfitLossItem.Revenue] * 0.60
```

There is no need to write `Year.*` or `Scenario.*`. A rule target that does not
mention `Year` or `Scenario` is applied across every item of those dimensions.
Use explicit item selectors only for actual periods, scenario overrides, or
other genuine exceptions:

```text
rule DCFValuation::DCFMetric.PVOfUFCF:Year.2030E:Scenario.Downside =
  CashFlowStatement::[CashFlowItem.UFCF] * 3.29
```

Do not add slice wildcards for dimensions absent from the target. In
particular, use `ProfitLoss::ProfitLossItem.COGS`, not
`ProfitLoss::ProfitLossItem.COGS:Year.*:Scenario.*`.

Do not use `*.*` or whole-cube wildcard mapping. Do not use wildcard
cross-cube references. Cross-cube references must name both the cube and the
explicit line item, for example:

```text
ProfitLoss::[ProfitLossItem.NetIncome]
```

For recurrence rules, omit all freely varying dimensions from the target and
use a sequential accessor in the RHS:

```text
rule CashFlowStatement::CashFlowItem.BeginningCash =
  CashFlowStatement::CashFlowItem.EndingCash:Year[PREV]
```

Valid sequential accessors are only `[FIRST]`, `[LAST]`, `[PREV]`, `[NEXT]`,
and `[THIS]`. They require a dimension declared with `dim_type: "seq"`:

- `Year[FIRST]`
- `Year[LAST]`
- `Year[PREV]`
- `Year[NEXT]`
- `Year[THIS]`

Never use dot notation for a sequential accessor. These are invalid:

- `Year.PREV`
- `Year.NEXT`
- `Year.THIS`

Also never write relative cells on the LHS:

- `Year[PREV]`
- `Year[NEXT]`
- `Year[THIS]`

For range operations on a sequential dimension, use `start..end` on the RHS or
inside an aggregate:

```text
SUM(CashFlowStatement::CashFlowItem.UFCF:Year.2026E..2030E)
```

For lagged/look-ahead point lookups on a sequential dimension (the Excel
`INDEX(row, COLUMN()-lag)` pattern), use `XLS_INDEX` over an **explicit range** —
never a `.*` wildcard. Wildcards inside `XLS_INDEX`/`INDEX` collapse to a
one-item slice on the embedded (wasm) runtime, so any index > 1 returns
`#EXPRESSION!`:

```text
IF(PosX<1, 0, XLS_INDEX(Revenue::[Month.M1..M120:RevItem.ProgramsLaunchedCum], PosX))
```

Compact shorthand is useful only when cube-relative binding is unambiguous:

```text
ProfitLoss::[ProfitLossItem.Revenue]
```

If the referenced cube differs in dimensions or the context would be ambiguous,
write the full cube-qualified address explicitly.

Bracket shorthand that combines item and sequential selectors is not a recurrence
form. Use a full canonical RHS address such as:

```text
CashFlowStatement::CashFlowItem.EndingCash:Year[PREV]
```

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
- Cube-qualified RHS references use the documented forms
  `ProfitLoss::[ProfitLossItem.Revenue]` or
  `ProfitLoss::ProfitLossItem.Revenue:Year.2030E`.
- Sequential dimensions use bracket accessors on the RHS:
  `Year[FIRST]`, `Year[PREV]`, `Year[THIS]`, `Year[NEXT]`, `Year[LAST]`.
- Derived formulas must use `is_anchored=false` and target broad slices.
  A formula rule is not a spreadsheet cell copy. Omit dimensions that should
  vary freely instead of writing `Year.*` or `Scenario.*`. Use explicit
  selectors only for a genuine period or scenario exception. Hardcoded actuals
  and assumptions may use hardvalues or explicit input rules; they must not be
  copied into dozens of formula rules.

Use `cell_range` only after reading the view's `view_row_keys` and
`view_col_keys`.

## Bulk loading and batch commands

Populate the model inside a dependency-tracking window, using the batch
commands instead of one call per object. Per-mutation dependent-graph
maintenance becomes an O(1) write, and each batch is one transaction —
one undo entry, one structure event, atomic failure.

Sequence:

1. `set_dependency_tracking` with `enabled: false`.
2. Create and populate: `create_dimension_items_batch`,
   `set_cell_hardvalues_batch_by_addr`, `apply_rule_batch`.
3. `set_dependency_tracking` with `enabled: true`.
4. `run_recalculation` with `scope: "all"` — the recalc force-enables
   tracking during the sweep, so this ordering is safe.

Params:

```text
create_dimension_items_batch:
  {entries: [{dim_id: "...", name: "..."}, ...]}
  — emit entries in display order; position is accepted but ignored.
  Atomic: one bad dim_id or name fails the whole batch.

set_cell_hardvalues_batch_by_addr:
  {cube_id: "...", entries: [{addr: ["at_value", ...item ids in cube dim order], value: ...}, ...]}
  — cube-scoped; cube_id is required alongside entries.

apply_rule_batch:
  {rules: [{cube_id, expression, targets: [[dim_name, item_name]], is_anchored: bool}, ...]}
  — rules with invalid expressions are skipped with a warning, not
  failed; the reply carries {applied: N}. Always compare applied
  against the submitted count and verify with workspace_rules.
```

Cells read inside the tracking-off window may be stale — dirty
propagation is suspended. Verify only after recalculation.

## Formatting

Formatting is semantic and rule-driven, not a spreadsheet presentation pass.
Use channels on the cube's `@` dimension:

- `@.format_number` for number, currency, or percent display
- `@.fill` for background fill
- `@.font_weight` for emphasis
- `@.font_color` for conditional or scenario-specific text

The `@.format_number` channel accepts only `general` or `preset:...`.
Use semicolon-separated preset parameters and `=` assignments:

```text
'preset:number(decimals=0; group=true; negative=parentheses; zero=dash)'
'preset:currency(code=USD; decimals=0; group=true; negative=parentheses; zero=dash)'
'preset:percent(decimals=1)'
```

Do not use raw Excel masks or `pattern:...` in a format rule.

Apply broad formats once by omitting freely varying dimensions:

```text
ProfitLoss::@.format_number:ProfitLossItem.* =
  'preset:number(decimals=0; group=true; negative=parentheses; zero=dash)'

DCFValuation::@.format_number:DCFMetric.WACC =
  'preset:percent(decimals=1)'
```

Do not add broad `@.fill` rules for ordinary line-item dimensions if they would
overwrite hardnumber highlighting. OM Core should continue to show hardcoded
inputs distinctly. Reserve fills for totals, checks, and deliberate scenario
bands. Omit `Year.*` and `Scenario.*` from formatting targets when the format
should apply across every omitted item.

Use compact hierarchy formatting:

- number formats on all statement/DCF cells
- bold font weight on totals and key output lines
- a subtle gray fill on totals
- no fill or border decorations on ordinary detail lines
- percent formatting on WACC, terminal growth, growth, margins, and returns
- stronger emphasis on EnterpriseValue, EquityValue, UFCF, TotalAssets,
  TotalLiabilitiesAndEquity, and NetIncome

Scenario presentation should use the same cells and values for all scenarios.
Do not create separate scenario tabs or duplicate statement sections.

Conditional formatting may use the value channel and a documented palette:

```text
Checks::@.fill:CheckMetric.BalanceSheetCheck =
  IF(Checks::[CheckMetric.BalanceSheetCheck] = 0, "#D9EAD3", "#F4CCCC")
```

When styling selected items or 2030E, name those selectors explicitly. Keep
general formats broad and add more-specific formatting rules afterward so
specificity and rule order produce the intended hierarchy.

## Build sequence

1. Clarify missing requirements only if they materially change the model.
   Reasonable defaults are Base/Upside/Downside, 2024A–2025A actuals,
   2026E–2030E forecast, and DCF valuation.
2. Discover existing workspace objects before creating anything.
3. Suspend dependency tracking (`set_dependency_tracking` false), then
   create years, scenarios, statement line-item dimensions, DCF metrics, and
   check metrics — dimension items via `create_dimension_items_batch`.
4. Create four statement/valuation cubes and a checks cube.
5. Create one view for each cube.
6. Enter only actual and assumption hardcodes with
   `set_cell_hardvalues_batch_by_addr`.
7. Add slice formulas for totals and derived values with
   `apply_rule_batch`. Prefer one rule covering
   all Year and Scenario items by omitting those dimensions from the target,
   over repeated per-year or per-scenario rules.
8. Link statements with explicit cube-qualified formulas only where necessary.
   Carry shared dimensions from context only when the binding is unambiguous.
9. Re-enable dependency tracking (`set_dependency_tracking` true), then run
   recalculation with `scope:"all"`.
10. Add broad number formats and visual hierarchy through `@` channels.
11. Verify every output with `cell_range`.
12. Add or update checks to prove ties and roll-forwards.
13. Recalculate again after any fix.

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
- DiscountFactor
- PVOfAnnualUFCF
- PVOfUFCF
- PVOfTerminalValue
- EnterpriseValue
- Debt
- Cash
- EquityValue

## DCF completeness

A DCF valuation table must not stop at terminal value and enterprise value.
Populate a complete annual discounted-cash-flow schedule:

- WACC for every forecast year and applicable scenario
- TerminalGrowth at the terminal-year forecast, normally 2030E
- DiscountFactor for every forecast year
- Annual UFCF from the CashFlowStatement
- PVOfAnnualUFCF for every forecast year
- PVOfUFCF as the sum of 2026E–2030E present values
- PVOfTerminalValue at 2030E
- EnterpriseValue, debt, cash, and equity value
- One `EquityValue` metric evaluated across the `Scenario` dimension. Keep
  `Base`, `Upside`, and `Downside` as scenario members; do not create separate
  `BaseEV`, `UpsideEV`, or `DownsideEV` metrics or repeat them under each
  scenario.

Use an intuitive DCF row order:

1. WACC
2. TerminalGrowth
3. EBITMargin
4. RevenueGrowth
5. TerminalRevenueMargin
6. UFCF
7. DiscountFactor
8. PVOfAnnualUFCF
9. PVOfUFCF
10. PVOfTerminalValue
11. EnterpriseValue
12. Debt
13. Cash
14. EquityValue

Financial cash-flow and valuation lines are in USD millions. Format them with
one decimal and thousands grouping, not as per-share or whole-dollar values:

```text
'preset:number(decimals=1; group=true; negative=parentheses; zero=dash)'
```

Format WACC, TerminalGrowth, RevenueGrowth, TerminalRevenueMargin,
EBITMargin, and DiscountFactor as percentages:

```text
'preset:percent(decimals=1)'
```

Use recurrence only for the discount-factor chain:

```text
rule DCFValuation::DCFMetric.DiscountFactor:Year.2026E =
  1 / (1 + DCFValuation::[DCFMetric.WACC])

rule DCFValuation::DCFMetric.DiscountFactor:Year.2027E =
  DCFValuation::DCFMetric.DiscountFactor:Year[PREV] /
  (1 + DCFValuation::[DCFMetric.WACC])
```

Every recurrence rule that may evaluate before the first valid predecessor
must guard `PREV`, `NEXT`, `FIRST`, or `LAST` with `POS(...)` and `IF(...)`.
Do not allow a recurrence to escape to 2024A or 2025A unless those periods
are explicitly seeded.

```text
IF(POS(Year)=1,929,
  IF(POS(Year)=2,3141,
     CashFlowStatement::CashFlowItem.EndingCash:Year[PREV]))
```

For discount factors:

```text
IF(POS(Year)<3,0,
  IF(POS(Year)=3,
     1/(1+DCFValuation::[DCFMetric.WACC]),
     DCFValuation::DCFMetric.DiscountFactor:Year[PREV]/(1+DCFValuation::[DCFMetric.WACC])))
```

`POS(Year)` is 1-based. Use it to return a seed or omit the recurrence branch
before evaluating `[PREV]`. This prevents `#REF!` at the beginning of an
ordered dimension.

Then calculate annual present value as:

```text
rule DCFValuation::DCFMetric.PVOfAnnualUFCF =
  CashFlowStatement::[CashFlowItem.UFCF] *
  DCFValuation::[DCFMetric.DiscountFactor]
```

At 2030E:

```text
rule DCFValuation::DCFMetric.PVOfUFCF:Year.2030E =
  SUM(DCFValuation::DCFMetric.PVOfAnnualUFCF:Year.2026E..2030E)

rule DCFValuation::DCFMetric.PVOfTerminalValue:Year.2030E =
  CashFlowStatement::CashFlowItem.UFCF:Year.2030E *
  (1 + DCFValuation::[DCFMetric.TerminalGrowth]) /
  (DCFValuation::[DCFMetric.WACC] -
   DCFValuation::[DCFMetric.TerminalGrowth]) *
  DCFValuation::[DCFMetric.DiscountFactor]
```

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

When repairing checks, trace the filing's own roll-forward arithmetic rather
than suppressing a non-zero result. For example, a 2025A cash-flow bridge must
use:

```text
BeginningCash + NetChangeInCash = EndingCash
17,388 - 3,141 = 14,247
```

Do not replace a failing amount with a plug or alter the check formula merely
to force a zero. Correct the underlying actual or formula, recalculate, and
verify the same check in every scenario.

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

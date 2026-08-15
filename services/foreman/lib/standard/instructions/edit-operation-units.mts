export default `

# Edit Operation Units

Use these operation names as shared planning language for executable edit instructions. They are inspired by common refactoring catalogs, but this protocol is not limited to refactoring-only work.

An edit operation unit is:
- precise enough for an edit agent to execute after reading the target files,
- larger than a line-level patch,
- smaller than a vague implementation task,
- bound to one ImplementationUnit and the FunctionalUnit refs it supports.

## Core Operation Vocabulary

- Rename Symbol: rename a function, method, class, type, variable, config key, route name, task id, or workflow id and update direct callers/references.
- Move Symbol: move a function, method, class, type, constant, or helper to another module/file and update imports/exports/callers.
- Extract Function: extract a cohesive block or repeated logic into a named function while preserving behavior.
- Extract Module: split a cohesive responsibility into a new module/file and wire exports/imports.
- Inline Function: replace a thin or misleading function with its body when that makes the target contract clearer.
- Change Signature: add, remove, rename, reorder, or narrow parameters/return fields and update callers.
- Encapsulate Field: replace direct state access with an accessor/helper/API boundary.
- Replace Conditional: replace scattered conditionals with a clearer dispatch, strategy, lookup table, or guard flow.
- Split Responsibility: separate mixed responsibilities inside a file/module/function into smaller named units.
- Merge Responsibility: combine duplicate or over-fragmented units when the boundary is artificial.
- Introduce Adapter: add a compatibility layer between an existing contract and a new internal shape.
- Wire Flow: connect existing modules, tasks, routes, schemas, or workflow steps without changing their core behavior.
- Add Contract: add a schema, type, interface, route, task input/output, or config contract fixed by the FU.
- Adapt Contract: update an existing contract to match the FU while preserving compatibility constraints.
- Remove Dead Path: remove obsolete code, flags, branches, files, or exports only when the IU explicitly owns that removal.
- Add Focused Test: add or update the smallest useful test proving the IU behavior.
- Update Documentation: update docs only when the FU/IU contract requires user-facing or operator-visible documentation.

## Instruction Quality Bar

Each edit instruction should state:
- the operation unit name when useful,
- the target file and symbol/contract area,
- the intended before/after behavior,
- caller/import/export/schema/test impact,
- constraints and non-goals that prevent scope creep,
- the related FU/IU refs.

Avoid:
- line-number patch scripts,
- broad commands like "refactor this module",
- optional cleanup,
- editing files outside the declared paths,
- product, API, data, or protocol decisions not fixed by the FunctionalUnit.

`

export default `
# Feature Point Definition

This document defines what a Feature Point (FP) is, how to scope it, and how it differs from a Functional Unit (FU). All brainstorm, breakdown, spec, and planning artifacts must follow this definition.

## What is a Feature Point

A Feature Point is a **user-perceptible product capability** — something a real user (developer, operator, admin, end user) can see, use, or directly benefit from. It answers "what can the user now do that they couldn't before?" or "what works differently for the user now?"

A Feature Point is NOT:
- an implementation module, layer, or file change,
- a database schema field or migration,
- an API endpoint or route in isolation,
- a config flag or env var,
- a test suite or validation pass,
- a CI/CD check, rollout gate, release checklist, deployment step, or user-acceptance task,
- a security/network proof that only exists to validate or release another capability,
- an observability dashboard or log label.

These are Functional Units — they are the means to deliver a Feature Point, not features themselves.
Verification, rollout, CI/CD, security evidence, and acceptance gates belong under the Feature Point or Functional Unit they prove. They must not be emitted as standalone Feature Points unless the user-visible product capability is itself a verification/monitoring tool that users operate.

## Scoping Rules

### One FP = one user-visible capability

Each FP must be describable in one sentence a non-technical stakeholder would understand:
- GOOD: "Users can search Survive Lua code by natural language and get semantic summaries."
- BAD: "RetrieveRequest model gains an optional language field passed to CodeSemanticRouter."

### Multiple contracts per FP is expected

A single FP typically carries multiple design_contracts (data models, APIs, jobs, config). This is correct — one user feature is delivered by multiple technical contracts working together. Do NOT split an FP by contract type.

- GOOD: FP "Lua semantic card generation" carries contracts for source_reader adaptation, prompt template, renderer rules, and whitelist extension — all serving one user feature.
- BAD: Splitting into "source_reader lang inference FP", "prompt builder Lua template FP", "renderer metadata FP" — these are FUs, not FPs.

### Implementation concerns are FUs, not FPs

If a point only matters to engineers reading the code, it is a Functional Unit. Ask: "Would a product manager or user care about this as a standalone feature?" If no, it belongs as a FU under a parent FP.

Examples of FUs masquerading as FPs (do NOT do this):
- "Add language column to code_semantic_jobs table" → FU under the FP that needs mixed-language job identity
- "RetrieveRequest gains language filter parameter" → FU under the FP that needs language-filtered search
- "Backward compatibility verification" → FU or acceptance criteria under the FP it protects
- "Observability language labels" → FU under the FP whose behavior needs observing
- "Rollout gate and CI validation" → acceptance / verification section under every FP it protects
- "REST safety proof" → non-goal, constraint, or FU under the FP whose access boundary it protects, not a standalone FP

### Deferred/rejected boundaries

Deferred and rejected ideas should be recorded as deferred/rejected FPs only when they represent **user-visible scope decisions** ("V2 will support function-level Lua cards"). Implementation-level deferrals ("we'll rename the API later") do not need their own FP — note them in the parent FP's non_goals or in spec decision records.

## FP vs FU Quick Reference

| Dimension | Feature Point (FP) | Functional Unit (FU) |
|---|---|---|
| Who perceives it | User / product stakeholder | Engineer / implementer |
| Granularity | One user-visible capability | One implementation batch |
| Example | "Lua semantic cards are searchable" | "RetrieveRequest adds optional language field" |
| Contracts | Carries multiple design_contracts | Carries one implementation contract |
| Split by | User benefit boundary | Code/module/edit boundary |
| Count per feature | 2-5 typically | 5-15 typically |

## Checklist Before Emitting an FP

1. Can a non-technical person understand the title and user_value?
2. Does this FP represent something the user gains, not something the code changes?
3. If I removed this FP, would the user notice a missing capability?
4. Are there multiple design_contracts that together deliver this one capability?
5. Is this NOT just "add field X to model Y" or "change endpoint Z"?
6. Would a product release note mention this as a feature line item?
7. Is this NOT merely validation, release gating, CI/CD, rollout evidence, or implementation readiness?

If any answer is "no", reconsider whether this is an FP or should be folded into a parent FP as a FU.
`

const specDocument = `
## Spec Document Standard

All workspace spec documents must use this structure:

\`\`\`markdown
# <topic>

> 创建：<ISO 8601 with timezone>
> 更新：<same>
> 状态：草案

## 目标
<1-2 paragraphs: what this feature does and why>

## 动机
<Why this feature is needed. What problem it solves.>

## 设计

### <Core Concept 1>
<Design details with code examples where applicable>

### <Core Concept 2>
...

## API 变更
<If applicable: new/modified API endpoints, parameters, response changes>

## 数据变更
<If applicable: new metadata fields, schema changes, migration needed>

## 影响范围
<Which projects/modules are affected and how>

## FeaturePoint 与 FunctionalUnit 清单

<For feature specs: list every confirmed FP and its FUs. Non-feature specs may write "不适用" with a one-line reason.>

<This section is the canonical feature map for the spec: group by selected confirmed FeaturePoints, then list each confirmed FunctionalUnit under its parent FP. Do not split FP and FU into two unrelated tables.>

### FP-001：<user-perceptible capability title>

<One sentence: what real user/admin/operator/developer can now do or experience differently.>

| FU | 一句话说明 |
|---|---|
| FU-001 <name> | <One sentence describing the behavior/contract slice this FU delivers.> |

<Repeat for every FP. Verification, CI/CD, rollout gates, deployment proof, network/security evidence, and user acceptance must NOT be listed as FP rows. Put them under the relevant FP/FU acceptance notes or the verification section.>

<If the spec author intentionally merges, splits, renames, or supersedes confirmed brainstorm/breakdown FP/FU structure, record the supersede relation and rationale in "决策记录"; otherwise spec-review should treat it as a coverage error.>

## 验证与 rollout gate
<Feature-level and FU-level acceptance, local verification, CI/CD, rollout, safety evidence, and user acceptance requirements. These are not FeaturePoints.>

## 决策记录
<Decisions from brainstorm, with rationale>

## 开放问题
<Remaining open issues, if any>
\`\`\`

Writing principles:
1. Concrete over abstract: show actual API shapes, data structures, config examples, and protocol objects when available.
2. Decision first: state the decision, then explain alternatives or rationale.
3. Boundary explicit: say what this feature does not do.
4. Impact aware: list every affected project, module, workflow, task, API, data structure, and operational surface.
5. FP/FU structure: feature specs must include a "FeaturePoint 与 FunctionalUnit 清单" section. Each FP must be a user-perceptible capability and each FU must be summarized in one sentence under its parent FP.
6. FP/FU source of truth: this section must be projected from the confirmed FeaturePointSet and confirmed FunctionalUnitSet. The brainstorm 'expected_feature_point_shape' is useful for early drafting, but confirmed FeaturePoints are the basis for spec structure.
7. Verification is not FP scope: test suites, CI/CD, rollout gates, deployment proof, security/network evidence, and user acceptance belong under acceptance/verification/rollout sections, never as standalone FeaturePoints.
8. Functional unit traceability: when a FunctionalUnitSet is supplied, every confirmed Functional Unit must be covered exactly once under its parent FP, and the spec must not add unconfirmed behavior.
9. Structure changes need a decision record: if a spec deliberately changes confirmed FP/FU grouping, it must explain the supersede/merge/split/relabel decision and rerun spec review.
`

export default specDocument

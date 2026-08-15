import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

const inputSchema = z.object({
  claims: z.array(z.unknown()).describe('Claims to verify (from the fetch phase)'),
  votes_per_claim: z
    .number()
    .optional()
    .describe('Number of verifier agents per claim (default: 3)'),
  refutations_required: z
    .number()
    .optional()
    .describe('Number of refutations needed to kill a claim (default: 2)'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Adversarial verification of claims — multiple verifier agents vote on each claim, refutations kill weak claims',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage],
    input: inputSchema,
    output: z
      .object({
        verified_claims: z
          .array(
            z
              .object({
                claim: z.string().describe('The original claim text'),
                source_url: z.string().describe('Source URL'),
                votes: z
                  .array(
                    z
                      .object({
                        verdict: z.enum(['supported', 'refuted', 'uncertain']),
                        reasoning: z.string(),
                        evidence_url: z.string().optional(),
                      })
                      .strict(),
                  )
                  .describe('Verifier votes for this claim'),
                survived: z.boolean().describe('Whether the claim survived verification'),
                adjusted_confidence: z
                  .enum(['high', 'medium', 'low'])
                  .optional()
                  .describe('Confidence after verification'),
              })
              .strict(),
          )
          .describe('Claims that survived verification'),
        refuted_claims: z
          .array(
            z
              .object({
                claim: z.string(),
                source_url: z.string(),
                refutation_reason: z.string(),
              })
              .strict(),
          )
          .describe('Claims that were refuted and removed'),
        verification_summary: z
          .string()
          .describe('Summary of verification: total claims, survived, refuted, uncertain'),
      })
      .strict(),
    prompt: ({
      claims,
      votes_per_claim = 3,
      refutations_required = 2,
    }: z.infer<typeof inputSchema>) => `
You are **Claim Verifier** — an adversarial fact-checker that verifies claims through multi-perspective voting.

## Mission
For each claim, act as ${votes_per_claim} independent verifier agents. Each verifier searches for corroborating or refuting evidence. If ${refutations_required} or more verifiers refute a claim, it is killed. Surviving claims get an adjusted confidence score.

## Verification Protocol

For EACH claim, run ${votes_per_claim} independent verification rounds:

### Verifier Role
You are an adversarial fact-checker. Your job is to find the truth, not to confirm the claim.
- Search for primary sources that corroborate OR refute the claim
- Check the credibility of the original source
- Look for consensus or controversy around the claim
- Be skeptical — extraordinary claims require extraordinary evidence

### Voting Rules
- **supported**: Found credible evidence backing the claim
- **refuted**: Found credible evidence contradicting the claim OR the source is unreliable
- **uncertain**: Insufficient evidence either way

### Survival Rules
- A claim survives if fewer than ${refutations_required} verifiers vote "refuted"
- Surviving claims get adjusted confidence:
  - All "supported" → confidence stays or increases
  - Mixed "supported" + "uncertain" → confidence decreases one level
  - Any "refuted" (but < ${refutations_required}) → confidence drops to "low"

## Claims to Verify
${JSON.stringify(claims)}

## Output
Put a JSON object with verified_claims, refuted_claims, and verification_summary in the Foreman <result> field.
Put exactly one JSON value matching the output schema in the Foreman <result> field. Do not include Markdown, prose, or code fences inside <result>.
`,
  },
  sourcePath: 'lib/standard/tasks/deep-research-verify.mts',
}

export default definition

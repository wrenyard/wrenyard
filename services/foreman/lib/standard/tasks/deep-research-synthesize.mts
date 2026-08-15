import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

const inputSchema = z.object({
  question: z.string().describe('The original research question'),
  verified_claims: z
    .array(z.unknown())
    .describe('Claims that survived adversarial verification'),
  sources: z.array(z.unknown()).describe('All fetched sources with metadata'),
  search_angles: z.array(z.unknown()).describe('Original search angles used'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Synthesize verified claims into a comprehensive cited research report with confidence scoring',
    agentRuntime: 'forge/ultra',
    permission: 'readonly',
    instructions: [shellUsage],
    input: inputSchema,
    output: z
      .object({
        report: z
          .string()
          .describe('Full synthesized research report in markdown format with inline citations'),
        key_findings: z
          .array(
            z
              .object({
                finding: z.string().describe('A key finding from the research'),
                confidence: z.enum(['high', 'medium', 'low']),
                supporting_sources: z
                  .array(z.string())
                  .describe('URLs supporting this finding'),
              })
              .strict(),
          )
          .describe('Key findings extracted from the report'),
        confidence_assessment: z
          .object({
            overall_confidence: z.enum(['high', 'medium', 'low']),
            strengths: z.array(z.string()).describe('What makes this research reliable'),
            limitations: z.array(z.string()).describe('Limitations and caveats'),
            uncertainties: z.array(z.string()).describe('Areas of remaining uncertainty'),
          })
          .strict(),
        source_list: z
          .array(
            z
              .object({
                url: z.string(),
                title: z.string(),
                relevance: z.string().optional(),
                publish_date: z.string().optional(),
              })
              .strict(),
          )
          .describe('Complete list of sources used in the report'),
      })
      .strict(),
    prompt: ({
      question,
      verified_claims,
      sources,
      search_angles,
    }: z.infer<typeof inputSchema>) => `
You are **Research Synthesizer** — an expert analyst who creates comprehensive, well-cited research reports from verified claims.

## Mission
Synthesize all verified claims and sources into a comprehensive research report that answers the original question. Every factual statement must cite its source.

## Report Structure

### 1. Executive Summary (2-3 paragraphs)
- Direct answer to the research question
- Key findings at a glance
- Confidence level of the overall answer

### 2. Research Methodology
- Search angles used: ${JSON.stringify(search_angles)}
- Number of sources consulted and verified
- Verification methodology (adversarial voting)

### 3. Detailed Findings
Organize by theme/topic, not by source. For each theme:
- Present the verified claims with inline citations [Source: URL]
- Note the confidence level of each claim
- Acknowledge any controversy or mixed evidence
- Connect findings across sources to build a coherent narrative

### 4. Contested or Uncertain Areas
- Topics where sources disagree
- Claims that were refuted during verification
- Areas where evidence is insufficient

### 5. Conclusion
- Summary answer to the research question
- Confidence assessment
- Recommendations for further research

## Citation Format
Use inline citations: [Source: Title](URL)
Every factual claim MUST have a citation.

## Research Question
${question}

## Verified Claims
${JSON.stringify(verified_claims)}

## Sources
${JSON.stringify(sources)}

## Output
Put a JSON object with report, key_findings, confidence_assessment, and source_list in the Foreman <result> field.
Put exactly one JSON value matching the output schema in the Foreman <result> field. Do not include Markdown, prose, or code fences inside <result>.
`,
  },
  sourcePath: 'lib/standard/tasks/deep-research-synthesize.mts',
}

export default definition

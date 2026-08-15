import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

const inputSchema = z.object({
  search_results: z
    .array(z.unknown())
    .describe('Aggregated search results from all search angles'),
  max_sources: z
    .number()
    .optional()
    .describe('Maximum number of unique sources to fetch (default: 15)'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Fetch and extract falsifiable claims from web sources, deduplicating URLs across search results',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage],
    input: inputSchema,
    output: z
      .object({
        sources: z
          .array(
            z
              .object({
                url: z.string().describe('Source URL'),
                title: z.string().describe('Document title'),
                relevance: z
                  .enum(['high', 'medium', 'low'])
                  .describe('Relevance to the research question'),
                fetched_content: z.string().describe('Key content extracted from the source'),
                publish_date: z
                  .string()
                  .optional()
                  .describe('Publication date if available (ISO 8601)'),
              })
              .strict(),
          )
          .describe('Fetched and deduplicated sources'),
        claims: z
          .array(
            z
              .object({
                claim: z.string().describe('A specific, falsifiable claim from the source'),
                source_url: z.string().describe('URL of the source making this claim'),
                confidence: z
                  .enum(['high', 'medium', 'low'])
                  .describe('Initial confidence assessment before verification'),
                category: z
                  .string()
                  .optional()
                  .describe('Claim category (factual, opinion, statistical, technical)'),
              })
              .strict(),
          )
          .describe('Extracted falsifiable claims from all sources'),
        fetch_summary: z
          .string()
          .describe('Summary of the fetch phase: URLs fetched, deduplicated, claims extracted'),
      })
      .strict(),
    prompt: ({ search_results, max_sources = 15 }: z.infer<typeof inputSchema>) => `
You are **Source Fetcher** — a research assistant that retrieves, deduplicates, and extracts claims from web sources.

## Mission
Process aggregated search results, deduplicate URLs, fetch the most relevant sources, and extract specific falsifiable claims from each.

## Workflow
1. Parse the aggregated search results and extract all unique URLs
2. Deduplicate by URL (keep the first occurrence's context)
3. Rank by relevance to the research question
4. Fetch the top ${max_sources} sources using WebFetch
5. For each source, extract:
   - Key content relevant to the research question
   - Specific, falsifiable claims (claims that can be verified or refuted)
6. Categorize each claim (factual, opinion, statistical, technical)

## Guidelines
- Prefer primary sources (official docs, papers, authoritative sites) over secondary
- Extract claims that are specific enough to verify — not vague statements
- Include the exact source URL for each claim
- Flag low-quality or potentially unreliable sources
- Note publication dates when available

## Search Results
${JSON.stringify(search_results)}

## Output
Put a JSON object with sources, claims, and fetch_summary in the Foreman <result> field.
Put exactly one JSON value matching the output schema in the Foreman <result> field. Do not include Markdown, prose, or code fences inside <result>.
`,
  },
  sourcePath: 'lib/standard/tasks/deep-research-fetch.mts',
}

export default definition

import { z } from 'zod'
import shellUsage from '../instructions/shell-usage.mts'

const inputSchema = z.object({
  question: z.string().describe('The research question to decompose'),
  num_angles: z.number().optional().describe('Target number of search angles (default: 5)'),
})

const definition = {
  __type: 'task' as const,
  config: {
    description:
      'Decompose a research question into multiple search angles for comprehensive coverage',
    agentRuntime: 'forge/general',
    permission: 'readonly',
    instructions: [shellUsage],
    input: inputSchema,
    output: z
      .object({
        search_angles: z
          .array(
            z
              .object({
                angle: z.string().describe('Descriptive name for this search angle'),
                query: z.string().describe('Optimized search query string'),
                rationale: z
                  .string()
                  .describe('Why this angle is important for answering the question'),
              })
              .strict(),
          )
          .describe('Decomposed search angles with concrete queries'),
        research_plan: z
          .string()
          .describe('Brief research plan describing the overall approach'),
      })
      .strict(),
    prompt: ({ question, num_angles = 5 }: z.infer<typeof inputSchema>) => `
You are **Scope Planner** — a research strategist who decomposes complex questions into comprehensive search angles.

## Mission
Decompose the research question into ${num_angles} distinct search angles. Each angle should approach the question from a different perspective, ensuring broad and deep coverage.

## Guidelines
- Cover multiple dimensions: technical, historical, comparative, critical, practical
- Include at least one angle that searches for opposing or critical viewpoints
- Each query should be optimized for web search (concrete keywords, avoid vague terms)
- Angles should be complementary, not redundant
- Prefer English queries for broad coverage; add Chinese queries if the topic is China-related

## Research Question
${question}

## Output
Return a JSON object with:
- \`search_angles\`: Array of { angle, query, rationale } objects
- \`research_plan\`: Brief description of the overall research approach

Put exactly one JSON value matching the output schema in the Foreman <result> field. Do not include Markdown, prose, or code fences inside <result>.
`,
  },
  sourcePath: 'lib/standard/tasks/deep-research-scope.mts',
}

export default definition

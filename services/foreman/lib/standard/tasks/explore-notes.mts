import { z } from 'zod'

const inputSchema = z.object({
  directions: z
    .array(
      z
        .object({
          direction: z
            .string()
            .describe('What this direction asks to investigate. Be specific and self-contained.'),
          keywords: z
            .array(z.string().min(1))
            .min(1)
            .describe('Non-empty seed terms for this direction. Used to derive independent query variants.'),
          context: z
            .string()
            .optional()
            .describe('Optional background/constraint that narrows or reframes this direction.'),
        })
        .strict(),
    )
    .min(1)
    .describe(
      'One or more investigation directions to explore across the configured default Obsidian vault. Each direction carries its own search intent and keywords.',
    ),
})

const definition = {
  __type: 'task' as const,
  config: {
    description: 'Explore Obsidian notes through notesmd-cli only — strictly read-only, multi-direction note investigation',
    agentRuntime: 'forge/fast',
    permission: 'readonly',
    instructions: [],
    input: inputSchema,
    output: z
      .object({
        status: z
          .enum(['completed', 'blocked'])
          .describe(
            'completed when notes were explored, blocked when notesmd-cli or its default vault is unavailable.',
          ),
        environment: z
          .object({
            notesmd_cli_available: z
              .boolean()
              .describe('Whether notesmd-cli is installed and can reach its configured default vault.'),
            message: z
              .string()
              .describe('Chinese status message about the notesmd-cli environment/configuration.'),
          })
          .strict(),
        results: z
          .array(
            z
              .object({
                direction: z.string().describe('Echo of the requested direction.'),
                references: z
                  .array(
                    z
                      .object({
                        note_id: z
                          .string()
                          .describe(
                            'Filename/path relative to the configured default Obsidian vault. Never an absolute path.',
                          ),
                        content: z
                          .string()
                          .describe(
                            'The original note body with the leading YAML frontmatter block removed, preserved verbatim. Not a summary.',
                          ),
                      })
                      .strict(),
                  )
                  .describe('One entry per requested direction, even when references is empty.'),
              })
              .strict(),
          )
          .describe('One entry per requested direction, even when references is empty.'),
        summary: z
          .string()
          .describe('Chinese one-paragraph summary of what was found across all directions.'),
      })
      .strict(),
    prompt: ({ directions }: z.infer<typeof inputSchema>) => `
You are **Notes Explorer** - a strictly read-only Obsidian note investigation agent.

## Hard Constraints
- READ-ONLY. You MUST NOT create, modify, move, delete, or write any file or git state.
- Notes may be accessed ONLY by invoking \`notesmd-cli\`. Never use Read, Glob, Grep, rg, find, cat, or any direct filesystem API for vault discovery or content.
- Never ask for, infer, print, or persist the vault path or vault identity. Rely entirely on the configured default vault. Do not echo absolute paths.
- Allowed \`notesmd-cli\` subcommands are ONLY: \`print\`, \`list\`, \`search\`, \`search-content\`.
- Explicitly FORBIDDEN subcommands and operations: \`create\`, \`open\`, \`daily\`, \`move\`, \`delete\`, \`frontmatter\`, \`set-default\`, and ALL filesystem/git write operations.
- Do NOT use pipes (\`|\`), redirection (\`>\`, \`<\`), command substitution (\`$()\`, backticks), shell chaining (\`&&\`, \`||\`, \`;\`), wrappers, or scripts around \`notesmd-cli\`. Run one allowed command form at a time, bare.

## Availability Probe
- Probe availability/configuration using the first needed allowed \`search\` or \`list\` operation.
- If \`notesmd-cli\` is unavailable, or it cannot access its configured default vault, STOP IMMEDIATELY. Do not fall back to any other tool or path.
- On such failure: set \`status\` to \`blocked\`, set \`environment.notesmd_cli_available\` to \`false\`, sanitize any absolute paths from \`environment.message\`, return an EMPTY \`results\` array, and use \`summary\` to describe the environment failure in Chinese.

## Investigation Workflow (only if available)
- For each direction, quickly derive MULTIPLE independent query variants from its direction/keywords/context.
- Use \`search\` plus \`search-content\` to cover both metadata/title and body matches.
- Cross-check multiple candidates; prefer a small, deduplicated evidence set.
- Then use \`print\` only on the strongest relevant notes.
- For every selected note, return the COMPLETE original body with ONLY the leading YAML frontmatter block removed. Preserve note text verbatim — do not summarize, paraphrase, or translate note content.
- Every requested direction MUST have exactly one \`results\` entry, even when its \`references\` array is empty.

## Directions
${JSON.stringify(directions, null, 2)}

## Output
Return exactly one JSON object matching the output schema in the Foreman <result> field. Do not include Markdown, prose, summaries, comments, or code fences inside <result>. The \`summary\` and \`environment.message\` MUST be written in Chinese; note \`content\` MUST be preserved verbatim in its original language.
`,
  },
  sourcePath: 'lib/standard/tasks/explore-notes.mts',
}

export default definition

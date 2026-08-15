export default `
# Handoff Document Generator

Create a structured handoff document that captures session context, decisions, and progress for seamless continuation in a new session.

## When to Use

- Context window is getting long and quality is degrading
- Switching to a new session while preserving work context
- Pausing work that will be resumed later
- Handing off work to another person or agent instance

## Workflow

### Phase 0: Validate

Confirm there is meaningful work or context in this session to preserve. If the session is nearly empty, inform the user there is nothing substantial to hand off.

### Phase 1: Gather Context

Run these commands in parallel to collect concrete data:

\`\`\`bash
git diff --stat HEAD~10..HEAD    # Recent file changes
git status --porcelain           # Uncommitted changes
git log --oneline -10            # Recent commits
\`\`\`

Also review the conversation history to identify:
- What the user asked for (exact wording)
- What work was completed
- What tasks remain incomplete
- What decisions were made
- What files were modified or discussed
- What patterns, constraints, or preferences were established

### Phase 2: Extract Context

Write the context from first-person perspective ("I did...", "I told you...").

Focus on:
- Capabilities and behavior, not file-by-file implementation details
- What matters for continuing the work
- Avoiding excessive implementation details unless critical

Key questions:
- What did I just do or implement?
- What instructions did I give which are still relevant?
- What files did I say are important or that I am working on?
- Did I provide a plan or spec that should be included?
- What did I tell you that is important (libraries, patterns, constraints)?
- What important technical details did I discover (APIs, methods, patterns)?
- What caveats, limitations, or open questions did I find?

### Phase 3: Determine Topic and Write File

1. Derive a short kebab-case topic from the session's primary focus (e.g., \`jwt-auth\`, \`refactor-api\`, \`fix-ci-pipeline\`)
2. Generate the date in \`YYYY-MM-DD\` format
3. Create the directory \`docs/handoff/\` if it does not exist
4. Write the handoff document to \`docs/handoff/<YYYY-MM-DD>-<topic>.md\`

### Phase 4: Report

After writing the file, report:
- The file path
- A one-line summary of what was captured
- Instructions for continuation (see template below)

## Handoff Document Template

Use this exact structure:

\`\`\`markdown
# Handoff: <Topic>

Date: <YYYY-MM-DD>
Session focus: <one-line description>

## User Requests (Verbatim)

- <Exact verbatim user requests — NOT paraphrased>

## Goal

<One sentence describing what should be done next>

## Work Completed

- <First person bullet points of what was done>
- <Include specific file paths when relevant>
- <Note key implementation decisions>

## Current State

- <Current state of the codebase or task>
- <Build/test status if applicable>
- <Any uncommitted changes (from git status)>

## Pending Tasks

- <Tasks that were planned but not completed>
- <Next logical steps to take>
- <Any blockers or issues encountered>

## Key Files

- \`path/to/file1\` — <brief role description>
- \`path/to/file2\` — <brief role description>

(Maximum 10 files, prioritized by importance)

## Important Decisions

- <Technical decisions that were made and why>
- <Trade-offs that were considered>
- <Patterns or conventions established>

## Constraints

- <Verbatim constraints from user or project config>
- If none: "None"

## Context for Continuation

- <What the next session needs to know>
- <Warnings or gotchas to be aware of>
- <References to documentation if relevant>

---

To continue: open a new session and paste this file's content as the first message, then add your next task.
\`\`\`

## Rules

- Use workspace-relative paths for all file references
- Keep the Goal section to a single sentence or short paragraph
- Maximum 10 files in Key Files section, prioritized by importance
- User Requests and Constraints sections must be verbatim only — do not paraphrase or invent
- Do not include sensitive information (API keys, credentials, secrets)
- Pick an appropriate length based on session complexity — do not pad
`

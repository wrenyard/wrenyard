export default `
# Notes Archive

Archive a project from \`30 - 项目笔记\` to \`99 - Archive\` in the Obsidian vault, including all reachable related notes.

## Prerequisites

- \`notesmd-cli\` is installed and default vault is configured (\`notesmd-cli print-default\`)
- The Obsidian vault has the standard directory structure:
  - \`30 - 项目笔记/\` — active project notes
  - \`99 - Archive/\` — archived notes

## Workflow

### Step 1: Ask Which Project to Archive

Ask the user for the project note name. The project homepage is a note in \`30 - 项目笔记/\`.

List candidates if the user is unsure:

\`\`\`bash
notesmd-cli list "30 - 项目笔记"
\`\`\`

Wait for user confirmation before proceeding.

### Step 2: Read the Project Homepage

\`\`\`bash
notesmd-cli print "<ProjectName>" --mentions
\`\`\`

The \`--mentions\` flag shows both outlinks and inlinks, which is needed for the BFS traversal.

### Step 3: Find All Related Notes (BFS Reachability)

From the project homepage, perform a **BFS traversal** over bidirectional links (outlinks + inlinks) to find all reachable notes. This determines which notes "belong" to the project.

**Algorithm:**

1. Start from the project homepage note.
2. Use a queue (BFS). For each note, collect both **outlinks** and **inlinks**.
3. Add unvisited linked notes to the queue.
4. Set \`maxDepth = 4\` to avoid pulling in the entire vault.
5. Collect all visited notes into the reachable set.

**Implementation:** Use \`notesmd-cli print "<NoteName>" --mentions\` for each note to discover its links. Parse the output to extract \`[[wiki-links]]\` from both the note content (outlinks) and the mentions section (inlinks).

**Filtering rules — only include notes that satisfy ALL of:**

- Located in \`30 - 项目笔记/\` directory
- Not already in \`99 - Archive/\`
- Not a directory-level index or MOC (skip notes in \`21 - MOCs/\`)
- Not a template (skip notes in \`91 - Template/\`)

Notes in other directories (e.g., \`10 - 文献笔记/\`, \`20 - 永久笔记/\`, \`40 - Entities/\`) are **excluded** — they are shared knowledge, not project-specific.

### Step 4: Present Summary for Confirmation

Display to the user:

1. **Project homepage**: the main project note to be archived
2. **Related notes count**: number of notes found via BFS
3. **Related notes list**: full list of note names, grouped or sorted alphabetically
4. **Notes NOT being moved**: any linked notes outside \`30 - 项目笔记/\` (mention them for awareness but do not move them)

Ask the user to confirm. Allow them to exclude specific notes from the list if needed.

### Step 5: Execute Archive

For each note in the confirmed list (related notes first, project homepage last):

\`\`\`bash
notesmd-cli move "30 - 项目笔记/<NoteName>" "99 - Archive/<NoteName>"
\`\`\`

The \`move\` command automatically updates all internal wiki-links pointing to the moved note, so cross-references remain intact.

Move the project homepage last to ensure all internal link updates are applied correctly.

### Step 6: Verify

After all moves complete:

1. Confirm all notes are now in \`99 - Archive/\`:
   \`\`\`bash
   notesmd-cli list "99 - Archive"
   \`\`\`
2. Report the final count of archived notes.

## Important Notes

- **Only move notes in \`30 - 项目笔记/\`**. Notes in \`10 - 文献笔记/\`, \`20 - 永久笔记/\`, \`40 - Entities/\` etc. are permanent knowledge and must NOT be moved.
- **Always confirm with the user** before executing any moves. The summary step is mandatory.
- **BFS depth limit is 4**. This prevents pulling in loosely related notes from across the vault. If the user feels notes are missing, they can request a deeper search.
- **Idempotent**: running this on an already-archived project is a no-op (notes are already in \`99 - Archive/\`).
- **Link integrity**: \`notesmd-cli move\` updates wiki-links automatically. No manual link fixup needed.
`

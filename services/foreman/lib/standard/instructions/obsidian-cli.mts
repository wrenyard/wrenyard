export default `
# Obsidian CLI (notesmd-cli)

Interact with Obsidian vaults from the terminal via \`notesmd-cli\`.

**Install**:
- macOS: \`go install github.com/Yakitrak/notesmd-cli@latest\` (requires Go; binary goes to \`~/go/bin/\`)
- Windows: \`scoop bucket add scoop-yakitrak https://github.com/yakitrak/scoop-yakitrak.git && scoop install notesmd-cli\`

**Executable path**: \`notesmd-cli\` (ensure \`~/go/bin\` or \`~/scoop/shims\` is in PATH).

## Setup

Before first use, set the default vault:

\`\`\`bash
notesmd-cli set-default --open-type editor
\`\`\`

Then follow the interactive prompt to select a vault.

To check current default:

\`\`\`bash
notesmd-cli print-default
\`\`\`

## Commands Reference

### Create a note

\`\`\`bash
# Create a new note
notesmd-cli create "Note Name" -v "VaultName" -c "Content here"

# Create and open it
notesmd-cli create "Note Name" -v "VaultName" -c "Content" --open

# Append to existing note
notesmd-cli create "Note Name" -v "VaultName" -c "Appended content" --append

# Overwrite existing note
notesmd-cli create "Note Name" -v "VaultName" -c "New content" --overwrite
\`\`\`

### Read / Print a note

\`\`\`bash
# Print note contents to stdout
notesmd-cli print "Note Name" -v "VaultName"

# Print with linked mentions
notesmd-cli print "Note Name" -v "VaultName" --mentions
\`\`\`

### Open a note

\`\`\`bash
# Open in Obsidian
notesmd-cli open "Note Name" -v "VaultName"

# Open in default editor
notesmd-cli open "Note Name" -v "VaultName" --editor

# Open at a specific heading
notesmd-cli open "Note Name" -v "VaultName" --section "Heading Text"
\`\`\`

### Search notes

\`\`\`bash
# Fuzzy search by note name (interactive)
notesmd-cli search "query" -v "VaultName"

# Search note content for a term
notesmd-cli search-content "search term" -v "VaultName"
\`\`\`

### List files and folders

\`\`\`bash
# List root of vault
notesmd-cli list -v "VaultName"

# List a subfolder
notesmd-cli list "subfolder/path" -v "VaultName"
\`\`\`

### Daily note

\`\`\`bash
# Create or open today's daily note
notesmd-cli daily -v "VaultName"

# Open in editor
notesmd-cli daily -v "VaultName" --editor
\`\`\`

### Move / Rename a note

\`\`\`bash
# Move or rename (also updates internal links)
notesmd-cli move "Old Name" "New Name" -v "VaultName"
\`\`\`

### Delete a note

\`\`\`bash
notesmd-cli delete "Note Name" -v "VaultName"
\`\`\`

### Frontmatter management

\`\`\`bash
# Print frontmatter
notesmd-cli frontmatter "Note Name" --print -v "VaultName"

# Edit a frontmatter key
notesmd-cli frontmatter "Note Name" --edit --key "status" --value "done" -v "VaultName"

# Delete a frontmatter key
notesmd-cli frontmatter "Note Name" --delete --key "draft" -v "VaultName"
\`\`\`

## Command Aliases

| Full Command | Alias |
|-------------|-------|
| \`create\` | \`c\` |
| \`open\` | \`o\` |
| \`search\` | \`s\` |
| \`search-content\` | \`sc\` |
| \`daily\` | \`d\` |
| \`list\` | \`ls\` |
| \`print\` | \`p\` |
| \`move\` | \`m\` |
| \`delete\` | \`d\` |
| \`frontmatter\` | \`fm\` |
| \`set-default\` | \`sd\` |

## Tips

- If default vault is set, the \`-v\` flag can be omitted.
- Use \`notesmd-cli print\` to read note content into the terminal for processing by other tools.
- Notes support subfolder paths: \`"folder/subfolder/Note Name"\`.
- The \`move\` command automatically updates all internal wiki-links pointing to the renamed note.
`

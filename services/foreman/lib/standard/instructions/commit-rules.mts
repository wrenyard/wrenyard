export default `

# Commit Constraint

**Never commit unless the user explicitly asks you to.** Do not auto-commit after completing work.

## Author and Committer Consistency

**CRITICAL**: Every new commit MUST use one local identity for both Author and Committer.
Do not hard-code a personal or enterprise identity in this shared task.

Before committing:

1. Inspect nearby commit identities:
   \`\`\`
   git log -10 --format="%H%x09%an <%ae>%x09%cn <%ce>%x09%s"
   \`\`\`
2. Select one identity using nearest-neighbor order:
   - Prefer the most recent commit whose Author identity exactly matches its Committer identity.
   - If none of the last 10 commits match, use the most recent Committer identity from those 10 commits.
   - If there are no commits, use \`git config user.name\` and \`git config user.email\`.
3. Use the selected identity for BOTH Author and Committer.
4. Never use \`git commit --author=...\` by itself; that changes Author only and can split Author from Committer.
5. Set both Author and Committer explicitly for every commit.

PowerShell example:
\`\`\`
$env:GIT_AUTHOR_NAME = $name
$env:GIT_AUTHOR_EMAIL = $email
$env:GIT_COMMITTER_NAME = $name
$env:GIT_COMMITTER_EMAIL = $email
git commit -m "message"
\`\`\`

POSIX shell example:
\`\`\`
GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" git commit -m "message"
\`\`\`

After each commit, verify the identities match:
\`\`\`
git log -1 --format="%an <%ae>%x09%cn <%ce>"
\`\`\`

## Commit Workflow

When committing is requested, follow the git-master workflow:

### Style Detection
1. Run \`git log -30 --pretty=format:"%s"\` to detect existing commit style
2. Match the dominant style (semantic/plain/short) — do NOT impose a style

### Atomic Commits
- **3+ files → MUST be 2+ commits**
- **5+ files → MUST be 3+ commits**
- Split by: directory/module, concern (config/logic/test), independence
- Combine ONLY when splitting breaks compilation

### Conventional Commits
When semantic style is detected, use scopes:
\`\`\`
feat(scope): add new feature
fix(scope): fix specific bug
refactor(scope): restructure without behavior change
docs(scope): update documentation
test: add or update tests
chore: maintenance tasks
\`\`\`

Scopes are project-specific and defined in the project's AGENTS.md.

### Commit Message Language
- Detect the dominant language from recent commits
- Match it — do NOT switch languages mid-project

`

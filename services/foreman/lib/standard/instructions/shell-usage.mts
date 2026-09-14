export default `

# Shell Usage

- Keep shell queries bounded: narrow paths and arguments, and cap long output with the tool's output limit instead of shell redirection such as \`2>&1 | head\`, which the restricted shell blocks.
- Prefer the native Read/Grep/Glob tools for reading and searching before reaching for shell scans.
- Run Git queries from the working directory with \`git --no-optional-locks <query>\`; \`git -C\` is unsupported, so \`cd\` into the target directory first when needed.
- When a Bash command is denied, do not repeat it or wait for a timeout: switch to the native read tools or report the exact missing permission.
- Keep private paths, accounts, and device details out of commands and reports.
- Avoid \`ls -R\`, broad \`grep -R\`, and heavy/generated paths like \`node_modules\`, \`.git\`, \`dist\`, \`build\`, \`coverage\`, \`.cache\`, lockfiles, logs, minified files, databases, and generated assets.
- Before reading files, identify the smallest likely relevant file set; prefer targeted reads like \`rg --files\`, \`rg "symbol" path/\`, and \`sed -n '120,220p' file\`.

`

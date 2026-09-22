export default `

# Shell Usage

- Unrestricted tools are a capability, not authorization to broaden scope. Follow the task purpose, declared targets, and explicit requested effects exactly.
- Explore, review, advisory, and other observational tasks remain observational: do not modify files or repository state even though write-capable tools are available.
- Do not commit, push, publish, contact external services, or cause other external side effects unless the task explicitly requests that exact action.
- Never include credentials, tokens, secret values, or unnecessary private account/device details in commands, output, evidence, or reports.
- Keep shell queries bounded: narrow paths and arguments and cap long output. Prefer targeted native read/search tools when they are the clearest fit.
- Quote paths and use normal argument boundaries such as \`--\` when a filename contains spaces or begins with a dash.
- Avoid \`ls -R\`, broad \`grep -R\`, and heavy/generated paths like \`node_modules\`, \`.git\`, \`dist\`, \`build\`, \`coverage\`, \`.cache\`, lockfiles, logs, minified files, databases, and generated assets.
- Before reading files, identify the smallest likely relevant file set; prefer targeted reads like \`rg --files\`, \`rg "symbol" path/\`, and \`sed -n '120,220p' file\`.

`

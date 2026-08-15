export default `

# Shell Usage

- Cap unknown large output with \`2>&1 | head -c 4000\`.
- Avoid \`ls -R\`, broad \`grep -R\`, and heavy/generated paths like \`node_modules\`, \`.git\`, \`dist\`, \`build\`, \`coverage\`, \`.cache\`, lockfiles, logs, minified files, databases, and generated assets.
- Before reading files, identify the smallest likely relevant file set; prefer targeted reads like \`rg --files\`, \`rg "symbol" path/\`, and \`sed -n '120,220p' file\`.

`

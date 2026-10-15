#!/usr/bin/env node
// Fake notifier adapter for the Bot mode dry-run demo (see docs/guides/bot-mode.md).
//
// Every accepted request is appended to the log file named by
// BOT_DEMO_NOTIFY_LOG as one JSON line, so the demo can assert that a dry run
// produced no notification. The log path and the message text are never
// printed anywhere except the log file itself.
//
// Adapter contract: read exactly one JSON request object from stdin, print
// exactly one JSON object on stdout, exit 0. Any `op` other than `send`, a
// missing BOT_DEMO_NOTIFY_LOG, or unparsable stdin writes one short message to
// stderr and exits 2.

import { appendFileSync, readFileSync } from 'node:fs'

const EXIT_USAGE = 2

function fail(message) {
  process.stderr.write(`fake-notifier: ${message}\n`)
  process.exit(EXIT_USAGE)
}

const logPath = process.env.BOT_DEMO_NOTIFY_LOG?.trim()
if (!logPath) fail('BOT_DEMO_NOTIFY_LOG is not set')

let request
try {
  request = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  fail('stdin is not valid JSON')
}
if (request === null || typeof request !== 'object' || Array.isArray(request)) {
  fail('the request must be a JSON object')
}
if (request.op !== 'send') {
  fail(`unsupported op: ${typeof request.op === 'string' ? request.op : '(missing)'}`)
}

appendFileSync(logPath, `${JSON.stringify(request)}\n`, 'utf8')

const messageId = readFileSync(logPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .length

process.stdout.write(`${JSON.stringify({ ok: true, messageId })}\n`)

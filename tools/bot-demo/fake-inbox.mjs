#!/usr/bin/env node
// Fake inbox adapter for the Bot mode dry-run demo (see docs/guides/bot-mode.md).
//
// Backed by one JSON file whose path comes from BOT_DEMO_INBOX. The file holds
// { "items": [ { id, title, body?, project?, open, released?, notes? } ] }.
//
// Adapter contract: read exactly one JSON request object from stdin, print
// exactly one JSON object on stdout, exit 0. An unknown or missing `op`, a
// missing or malformed BOT_DEMO_INBOX, or unparsable stdin writes one short
// message to stderr and exits 2.
//
// Items the request does not name are never modified, so the demo can assert
// that its source item is still open after the run.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'

const EXIT_USAGE = 2

function fail(message) {
  process.stderr.write(`fake-inbox: ${message}\n`)
  process.exit(EXIT_USAGE)
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function loadInbox(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.items)) {
    throw new Error('the inbox file must be an object with an items array')
  }
  return parsed
}

/** Write through a sibling temp file so a reader never sees a partial file. */
function saveInbox(path, inbox) {
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(inbox, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

const inboxPath = process.env.BOT_DEMO_INBOX?.trim()
if (!inboxPath) fail('BOT_DEMO_INBOX is not set')

let request
try {
  request = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  fail('stdin is not valid JSON')
}
if (request === null || typeof request !== 'object' || Array.isArray(request)) {
  fail('the request must be a JSON object')
}

let inbox
try {
  inbox = loadInbox(inboxPath)
} catch (error) {
  fail(`could not read the inbox file: ${error instanceof Error ? error.message : String(error)}`)
}

const requestId = typeof request.id === 'string' ? request.id : ''
const findItem = (id) => inbox.items.find((item) => item !== null && typeof item === 'object' && item.id === id) ?? null

function requireItem() {
  const item = findItem(requestId)
  if (!item) fail(`unknown item id: ${requestId || '(missing)'}`)
  return item
}

/** The list projection: identity plus the fields a bot item needs to start. */
function publicItem(item) {
  const projected = { id: item.id, title: item.title }
  if (typeof item.body === 'string') projected.body = item.body
  if (typeof item.project === 'string') projected.project = item.project
  return projected
}

switch (typeof request.op === 'string' ? request.op : '') {
  case 'list': {
    const items = inbox.items
      .filter((item) => item !== null && typeof item === 'object' && item.open === true && item.released !== true)
      .map(publicItem)
    print({ items })
    break
  }
  case 'get': {
    const item = findItem(requestId)
    print({ item: item === null ? null : { ...item, open: item.open === true } })
    break
  }
  case 'complete': {
    requireItem().open = false
    saveInbox(inboxPath, inbox)
    print({ ok: true })
    break
  }
  case 'annotate': {
    const item = requireItem()
    if (!Array.isArray(item.notes)) item.notes = []
    item.notes.push(typeof request.text === 'string' ? request.text : '')
    saveInbox(inboxPath, inbox)
    print({ ok: true })
    break
  }
  case 'release': {
    requireItem().released = true
    saveInbox(inboxPath, inbox)
    print({ ok: true })
    break
  }
  default:
    fail(`unknown op: ${typeof request.op === 'string' ? request.op : '(missing)'}`)
}

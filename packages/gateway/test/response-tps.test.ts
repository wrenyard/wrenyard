import assert from 'node:assert/strict';
import test from 'node:test';
import { ResponseSampler } from '../src/response-tps.ts';

/** Deterministic clock returning the next provided timestamp on each call. */
function clock(times: number[]): () => number {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)]!;
}

function event(record: Record<string, unknown>): string {
  return `data: ${JSON.stringify(record)}\n\n`;
}

const USAGE = { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105 };

test('samples a fragmented stream with one sample', () => {
  const sampler = new ResponseSampler({ now: clock([100, 900]), normalizeModel: (m) => (m === 'private' ? 'vendor/public' : m) });
  const body = event({ id: 'r1', model: 'private', choices: [{ delta: { content: 'he' } }] })
    + event({ id: 'r1', model: 'private', choices: [{ delta: { content: 'llo' }, finish_reason: null }] })
    + event({ id: 'r1', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] })
    + event({ id: 'r1', model: 'private', choices: [], usage: USAGE })
    + 'data: [DONE]\n\n';
  for (const char of body) sampler.feed(char);
  sampler.end();
  const sample = sampler.sample();
  assert.ok(sample);
  assert.equal(sample.tps_sampling_contract, 'response_v1');
  assert.deepEqual(sample.tps_samples, [{
    response_id: 'r1',
    model: 'vendor/public',
    output_tokens: 100,
    first_token_at_ms: 100,
    completed_at_ms: 900,
  }]);
});

test('counts reasoning and tool-call arguments as first generation', () => {
  const sampler = new ResponseSampler({ now: clock([10, 30]) });
  sampler.feed(event({ id: 'r2', model: 'private', choices: [{ delta: { reasoning_content: 'think' } }] }));
  sampler.feed(event({ id: 'r2', model: 'private', choices: [{ delta: { content: 'x' } }] }));
  sampler.feed(event({ id: 'r2', model: 'private', choices: [{ delta: { tool_calls: [{ function: { arguments: '{"a":1}' } }] } }] }));
  sampler.feed(event({ id: 'r2', model: 'private', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  sampler.feed(event({ id: 'r2', model: 'private', choices: [], usage: USAGE }));
  sampler.feed('data: [DONE]\n\n');
  sampler.end();
  const sample = sampler.sample();
  assert.ok(sample);
  assert.equal(sample.tps_samples[0]!.first_token_at_ms, 10);
  assert.equal(sample.tps_samples[0]!.completed_at_ms, 30);
});

test('excludes the pre-first-delta delay and the post-finish usage delay', () => {
  const now = clock([500, 2500]);
  const sampler = new ResponseSampler({ now });
  sampler.feed(event({ id: 'r3', model: 'private', choices: [{ delta: { role: 'assistant' } }] }));
  sampler.feed(event({ id: 'r3', model: 'private', choices: [{ delta: { content: 'a' } }] }));
  sampler.feed(event({ id: 'r3', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  sampler.feed(event({ id: 'r3', model: 'private', choices: [], usage: USAGE }));
  sampler.feed('data: [DONE]\n\n');
  sampler.end();
  const sample = sampler.sample();
  assert.ok(sample);
  // first delta at 500, completion at 2500; the 9000 usage timestamp is unused.
  assert.equal(sample.tps_samples[0]!.first_token_at_ms, 500);
  assert.equal(sample.tps_samples[0]!.completed_at_ms, 2500);
});

test('finalizes only after the terminal marker even when usage arrives later', () => {
  const sampler = new ResponseSampler({ now: clock([1, 2]) });
  sampler.feed(event({ id: 'r4', model: 'private', choices: [{ delta: { content: 'a' } }] }));
  assert.equal(sampler.sample(), undefined);
  sampler.feed(event({ id: 'r4', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  assert.equal(sampler.sample(), undefined);
  sampler.feed(event({ id: 'r4', model: 'private', choices: [], usage: USAGE }));
  assert.equal(sampler.sample(), undefined);
  sampler.feed('data: [DONE]\n\n');
  assert.ok(sampler.sample());
});

test('yields no sample for error terminal, truncation, or nonstream bodies', () => {
  const errored = new ResponseSampler({ now: () => 1 });
  errored.feed(event({ id: 'e', model: 'private', choices: [], error: { message: 'boom' } }));
  errored.feed('data: [DONE]\n\n');
  errored.end();
  assert.equal(errored.sample(), undefined);

  const truncated = new ResponseSampler({ now: () => 1 });
  truncated.feed(event({ id: 't', model: 'private', choices: [{ delta: { content: 'a' }, finish_reason: 'length' }] }));
  truncated.feed(event({ id: 't', model: 'private', choices: [], usage: USAGE }));
  // No [DONE]: an unterminated stream never samples.
  truncated.end();
  assert.equal(truncated.sample(), undefined);

  const nonstream = new ResponseSampler({ now: () => 1 });
  nonstream.markNonStream();
  nonstream.feed(event({ id: 'j', model: 'private', choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }], usage: USAGE }));
  nonstream.feed('data: [DONE]\n\n');
  nonstream.end();
  assert.equal(nonstream.sample(), undefined);
});

test('rejects a missing response id or usage and conflicting ids/models/counts', () => {
  const noId = new ResponseSampler({ now: clock([1, 2]) });
  noId.feed(event({ model: 'private', choices: [{ delta: { content: 'a' } }] }));
  noId.feed(event({ model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  noId.feed(event({ model: 'private', choices: [], usage: USAGE }));
  noId.feed('data: [DONE]\n\n');
  noId.end();
  assert.equal(noId.sample(), undefined);

  const noUsage = new ResponseSampler({ now: clock([1, 2]) });
  noUsage.feed(event({ id: 'n', model: 'private', choices: [{ delta: { content: 'a' } }] }));
  noUsage.feed(event({ id: 'n', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  noUsage.feed('data: [DONE]\n\n');
  noUsage.end();
  assert.equal(noUsage.sample(), undefined);

  const conflictId = new ResponseSampler({ now: clock([1, 2]) });
  conflictId.feed(event({ id: 'a', model: 'private', choices: [{ delta: { content: 'x' } }] }));
  conflictId.feed(event({ id: 'b', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  conflictId.feed(event({ id: 'b', model: 'private', choices: [], usage: USAGE }));
  conflictId.feed('data: [DONE]\n\n');
  conflictId.end();
  assert.equal(conflictId.sample(), undefined);

  const conflictModel = new ResponseSampler({ now: clock([1, 2]) });
  conflictModel.feed(event({ id: 'm', model: 'one', choices: [{ delta: { content: 'x' } }] }));
  conflictModel.feed(event({ id: 'm', model: 'two', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  conflictModel.feed(event({ id: 'm', model: 'one', choices: [], usage: USAGE }));
  conflictModel.feed('data: [DONE]\n\n');
  conflictModel.end();
  assert.equal(conflictModel.sample(), undefined);

  const conflictCount = new ResponseSampler({ now: clock([1, 2]) });
  conflictCount.feed(event({ id: 'c', model: 'private', choices: [{ delta: { content: 'x' } }] }));
  conflictCount.feed(event({ id: 'c', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  conflictCount.feed(event({ id: 'c', model: 'private', choices: [], usage: { completion_tokens: 100 } }));
  conflictCount.feed(event({ id: 'c', model: 'private', choices: [], usage: { completion_tokens: 101 } }));
  conflictCount.feed('data: [DONE]\n\n');
  conflictCount.end();
  assert.equal(conflictCount.sample(), undefined);
});

test('rejects a zero-length generation interval', () => {
  const sampler = new ResponseSampler({ now: clock([42, 42]) });
  sampler.feed(event({ id: 'z', model: 'private', choices: [{ delta: { content: 'a' } }] }));
  sampler.feed(event({ id: 'z', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  sampler.feed(event({ id: 'z', model: 'private', choices: [], usage: USAGE }));
  sampler.feed('data: [DONE]\n\n');
  sampler.end();
  assert.equal(sampler.sample(), undefined);
});

test('rejects a fractional completion token count rather than rounding it', () => {
  const sampler = new ResponseSampler({ now: clock([100, 900]) });
  sampler.feed(event({ id: 'fr', model: 'private', choices: [{ delta: { content: 'a' } }] }));
  sampler.feed(event({ id: 'fr', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  sampler.feed(event({ id: 'fr', model: 'private', choices: [], usage: { completion_tokens: 100.5 } }));
  sampler.feed('data: [DONE]\n\n');
  sampler.end();
  assert.equal(sampler.sample(), undefined);
});

test('rejects an unsafe integer or negative completion token count', () => {
  const unsafe = new ResponseSampler({ now: clock([100, 900]) });
  unsafe.feed(event({ id: 'u', model: 'private', choices: [{ delta: { content: 'a' } }] }));
  unsafe.feed(event({ id: 'u', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  unsafe.feed(event({ id: 'u', model: 'private', choices: [], usage: { completion_tokens: Number.MAX_SAFE_INTEGER + 2 } }));
  unsafe.feed('data: [DONE]\n\n');
  unsafe.end();
  assert.equal(unsafe.sample(), undefined);

  const negative = new ResponseSampler({ now: clock([100, 900]) });
  negative.feed(event({ id: 'n', model: 'private', choices: [{ delta: { content: 'a' } }] }));
  negative.feed(event({ id: 'n', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  negative.feed(event({ id: 'n', model: 'private', choices: [], usage: { completion_tokens: -5 } }));
  negative.feed('data: [DONE]\n\n');
  negative.end();
  assert.equal(negative.sample(), undefined);
});

test('rejects a multi-choice response', () => {
  const twoChoices = new ResponseSampler({ now: clock([100, 900]) });
  twoChoices.feed(event({
    id: 'm2',
    model: 'private',
    choices: [{ index: 0, delta: { content: 'a' } }, { index: 1, delta: { content: 'b' } }],
  }));
  twoChoices.feed(event({ id: 'm2', model: 'private', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: USAGE }));
  twoChoices.feed('data: [DONE]\n\n');
  twoChoices.end();
  assert.equal(twoChoices.sample(), undefined);

  const nonzeroIndex = new ResponseSampler({ now: clock([100, 900]) });
  nonzeroIndex.feed(event({ id: 'm3', model: 'private', choices: [{ index: 1, delta: { content: 'a' } }] }));
  nonzeroIndex.feed(event({ id: 'm3', model: 'private', choices: [{ index: 1, delta: {}, finish_reason: 'stop' }], usage: USAGE }));
  nonzeroIndex.feed('data: [DONE]\n\n');
  nonzeroIndex.end();
  assert.equal(nonzeroIndex.sample(), undefined);
});

test('joins multiline SSE data split over data: lines until the blank separator', () => {
  const sampler = new ResponseSampler({ now: clock([100, 900]) });
  // One logical event whose JSON payload is split across three `data:` lines.
  const payload = JSON.stringify({
    id: 'ml',
    model: 'private',
    choices: [{ index: 0, delta: { content: 'a' }, finish_reason: 'stop' }],
    usage: USAGE,
  });
  const split = payload.replace(',"model"', ',\n"model"').replace(',"choices"', ',\n"choices"').split('\n');
  sampler.feed(split.map((part) => `data: ${part}`).join('\n') + '\n\n');
  sampler.feed('data: [DONE]\n\n');
  sampler.end();
  const sample = sampler.sample();
  assert.ok(sample);
  assert.equal(sample.tps_samples[0]!.response_id, 'ml');
  assert.equal(sample.tps_samples[0]!.output_tokens, 100);
});

test('rejects data that arrives after the terminal marker', () => {
  const sampler = new ResponseSampler({ now: clock([100, 900]) });
  sampler.feed(event({ id: 'td', model: 'private', choices: [{ delta: { content: 'a' } }] }));
  sampler.feed(event({ id: 'td', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE }));
  sampler.feed('data: [DONE]\n\n');
  // A contradictory event after DONE invalidates the whole response.
  sampler.feed(event({ id: 'td', model: 'other', choices: [{ delta: { content: 'more' } }] }));
  sampler.end();
  assert.equal(sampler.sample(), undefined);
});

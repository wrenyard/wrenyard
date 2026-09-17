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

/** cl100k_base token counts for the fixture strings, verified against js-tiktoken 1.0.21. */
const TOKENS_HELLO = 1;
const TOKENS_CHANNELS = 7; // 'x' + 'think' + '{"a":1}'

test('samples a fragmented stream with one tokenizer_v1 sample', () => {
  const sampler = new ResponseSampler({ now: clock([100, 900]), normalizeModel: (m) => (m === 'private' ? 'vendor/public' : m) });
  const body = event({ id: 'r1', model: 'private', choices: [{ delta: { content: 'he' } }] })
    + event({ id: 'r1', model: 'private', choices: [{ delta: { content: 'llo' }, finish_reason: null }] })
    + event({ id: 'r1', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] })
    + event({ id: 'r1', model: 'private', choices: [], usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105 } })
    + 'data: [DONE]\n\n';
  for (const char of body) sampler.feed(char);
  sampler.end();
  const sample = sampler.sample();
  assert.ok(sample);
  assert.equal(sample.tps_sampling_contract, 'tokenizer_v1');
  assert.deepEqual(sample.tps_samples, [{
    response_id: 'r1',
    model: 'vendor/public',
    output_tokens: TOKENS_HELLO,
    first_token_at_ms: 100,
    completed_at_ms: 900,
  }]);
});

test('token count is independent of delta and network segmentation', () => {
  const split = new ResponseSampler({ now: clock([100, 900]) });
  split.feed(event({ id: 's1', model: 'private', choices: [{ delta: { content: 'he' } }] }));
  split.feed(event({ id: 's1', model: 'private', choices: [{ delta: { content: 'llo' } }] }));
  split.feed('data: [DONE]\n\n');
  split.end();

  const whole = new ResponseSampler({ now: clock([100, 900]) });
  whole.feed(event({ id: 's1', model: 'private', choices: [{ delta: { content: 'hell' } }] })
    + event({ id: 's1', model: 'private', choices: [{ delta: { content: 'o' } }] })
    + 'data: [DONE]\n\n');
  whole.end();

  assert.equal(split.sample()!.tps_samples[0]!.output_tokens, TOKENS_HELLO);
  assert.equal(whole.sample()!.tps_samples[0]!.output_tokens, TOKENS_HELLO);
});

test('counts text, reasoning, and tool arguments as separate channels', () => {
  const sampler = new ResponseSampler({ now: clock([10, 200, 500]) });
  sampler.feed(event({ id: 'r2', model: 'private', choices: [{ delta: { reasoning_content: 'think' } }] }));
  sampler.feed(event({ id: 'r2', model: 'private', choices: [{ delta: { content: 'x' } }] }));
  sampler.feed(event({ id: 'r2', model: 'private', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] }));
  sampler.feed(event({ id: 'r2', model: 'private', choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
  sampler.feed('data: [DONE]\n\n');
  sampler.end();
  const sample = sampler.sample();
  assert.ok(sample);
  assert.equal(sample.tps_samples[0]!.output_tokens, TOKENS_CHANNELS);
  assert.equal(sample.tps_samples[0]!.first_token_at_ms, 10);
  assert.equal(sample.tps_samples[0]!.completed_at_ms, 500);
});

test('excludes completion latency and trailing usage from the window', () => {
  const sampler = new ResponseSampler({ now: clock([500, 1500, 2500, 9000]) });
  sampler.feed(event({ id: 'r3', model: 'private', choices: [{ delta: { role: 'assistant' } }] }));
  sampler.feed(event({ id: 'r3', model: 'private', choices: [{ delta: { content: 'he' } }] }));
  sampler.feed(event({ id: 'r3', model: 'private', choices: [{ delta: { content: 'llo' } }] }));
  sampler.feed(event({ id: 'r3', model: 'private', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  sampler.feed(event({ id: 'r3', model: 'private', choices: [], usage: { completion_tokens: 100 } }));
  sampler.feed('data: [DONE]\n\n');
  sampler.end();
  const sample = sampler.sample();
  assert.ok(sample);
  // first delta at 500, last nonempty delta at 1500; the finish marker at 2500
  // and the usage event at 9000 never extend the generation window.
  assert.equal(sample.tps_samples[0]!.first_token_at_ms, 500);
  assert.equal(sample.tps_samples[0]!.completed_at_ms, 1500);
});

test('samples without any usage report; usage is not a speed gate', () => {
  const sampler = new ResponseSampler({ now: clock([100, 900]) });
  sampler.feed(event({ id: 'u1', model: 'private', choices: [{ delta: { content: 'he' } }] }));
  sampler.feed(event({ id: 'u1', model: 'private', choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] }));
  sampler.feed('data: [DONE]\n\n');
  sampler.end();
  assert.ok(sampler.sample());
});

test('conflicting or fractional usage reports no longer reject the sample', () => {
  const sampler = new ResponseSampler({ now: clock([100, 900]) });
  sampler.feed(event({ id: 'u2', model: 'private', choices: [{ delta: { content: 'he' } }] }));
  sampler.feed(event({ id: 'u2', model: 'private', choices: [{ delta: { content: 'llo' } }] }));
  sampler.feed(event({ id: 'u2', model: 'private', choices: [], usage: { completion_tokens: 100, reasoning_tokens: 500 } }));
  sampler.feed(event({ id: 'u2', model: 'private', choices: [], usage: { completion_tokens: 100.5 } }));
  sampler.feed('data: [DONE]\n\n');
  sampler.end();
  const sample = sampler.sample();
  assert.ok(sample);
  // Hidden reasoning tokens and reported usage never enter the approximation.
  assert.equal(sample.tps_samples[0]!.output_tokens, TOKENS_HELLO);
});

test('does not sample a truncated stream', () => {
  const sampler = new ResponseSampler({ now: clock([100, 400]) });
  sampler.feed(event({ id: 'p1', model: 'private', choices: [{ delta: { content: 'he' } }] }));
  sampler.feed(event({ id: 'p1', model: 'private', choices: [{ delta: { content: 'llo' } }] }));
  sampler.end();
  assert.equal(sampler.sample(), undefined);
});

test('yields no sample for error records, error terminal, or nonstream bodies', () => {
  const errored = new ResponseSampler({ now: clock([100, 900]) });
  errored.feed(event({ id: 'e', model: 'private', choices: [{ delta: { content: 'he' } }] }));
  errored.feed(event({ id: 'e', model: 'private', choices: [], error: { message: 'boom' } }));
  errored.feed('data: [DONE]\n\n');
  errored.end();
  assert.equal(errored.sample(), undefined);

  const filtered = new ResponseSampler({ now: clock([100, 900]) });
  filtered.feed(event({ id: 'f', model: 'private', choices: [{ delta: { content: 'he' } }] }));
  filtered.feed(event({ id: 'f', model: 'private', choices: [{ delta: {}, finish_reason: 'content_filter' }] }));
  filtered.feed('data: [DONE]\n\n');
  filtered.end();
  assert.equal(filtered.sample(), undefined);

  const nonstream = new ResponseSampler({ now: () => 1 });
  nonstream.markNonStream();
  nonstream.feed(event({ id: 'j', model: 'private', choices: [{ delta: { content: 'he' }, finish_reason: 'stop' }], usage: { completion_tokens: 1 } }));
  nonstream.feed('data: [DONE]\n\n');
  nonstream.end();
  assert.equal(nonstream.sample(), undefined);
});

test('rejects a missing response id and conflicting ids, models, or replay after [DONE]', () => {
  const noId = new ResponseSampler({ now: clock([100, 900]) });
  noId.feed(event({ model: 'private', choices: [{ delta: { content: 'he' } }] }));
  noId.feed(event({ model: 'private', choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] }));
  noId.feed('data: [DONE]\n\n');
  noId.end();
  assert.equal(noId.sample(), undefined);

  const conflictId = new ResponseSampler({ now: clock([100, 900]) });
  conflictId.feed(event({ id: 'a', model: 'private', choices: [{ delta: { content: 'he' } }] }));
  conflictId.feed(event({ id: 'b', model: 'private', choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] }));
  conflictId.feed('data: [DONE]\n\n');
  conflictId.end();
  assert.equal(conflictId.sample(), undefined);

  const conflictModel = new ResponseSampler({ now: clock([100, 900]) });
  conflictModel.feed(event({ id: 'm', model: 'one', choices: [{ delta: { content: 'he' } }] }));
  conflictModel.feed(event({ id: 'm', model: 'two', choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] }));
  conflictModel.feed('data: [DONE]\n\n');
  conflictModel.end();
  assert.equal(conflictModel.sample(), undefined);

  const replay = new ResponseSampler({ now: clock([100, 900]) });
  replay.feed(event({ id: 'td', model: 'private', choices: [{ delta: { content: 'he' } }] }));
  replay.feed(event({ id: 'td', model: 'private', choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] }));
  replay.feed('data: [DONE]\n\n');
  // A contradictory event after DONE invalidates the whole response.
  replay.feed(event({ id: 'td', model: 'other', choices: [{ delta: { content: 'more' } }] }));
  replay.end();
  assert.equal(replay.sample(), undefined);
});

test('skips single-timestamp and too-short windows', () => {
  const simultaneous = new ResponseSampler({ now: clock([42, 42]) });
  simultaneous.feed(event({ id: 'w1', model: 'private', choices: [{ delta: { content: 'he' } }] }));
  simultaneous.feed(event({ id: 'w1', model: 'private', choices: [{ delta: { content: 'llo' } }] }));
  simultaneous.feed('data: [DONE]\n\n');
  simultaneous.end();
  assert.equal(simultaneous.sample(), undefined);

  const tooShort = new ResponseSampler({ now: clock([100, 150]) });
  tooShort.feed(event({ id: 'w2', model: 'private', choices: [{ delta: { content: 'he' } }] }));
  tooShort.feed(event({ id: 'w2', model: 'private', choices: [{ delta: { content: 'llo' } }] }));
  tooShort.feed('data: [DONE]\n\n');
  tooShort.end();
  assert.equal(tooShort.sample(), undefined);

  // A fully buffered stream carries no arrival timing at all.
  const buffered = new ResponseSampler({ now: () => 7 });
  buffered.feed(event({ id: 'w3', model: 'private', choices: [{ delta: { content: 'he' } }] })
    + event({ id: 'w3', model: 'private', choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] })
    + 'data: [DONE]\n\n');
  buffered.end();
  assert.equal(buffered.sample(), undefined);
});

test('rejects a multi-choice response', () => {
  const twoChoices = new ResponseSampler({ now: clock([100, 900]) });
  twoChoices.feed(event({
    id: 'm2',
    model: 'private',
    choices: [{ index: 0, delta: { content: 'he' } }, { index: 1, delta: { content: 'b' } }],
  }));
  twoChoices.feed(event({ id: 'm2', model: 'private', choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: 'stop' }] }));
  twoChoices.feed('data: [DONE]\n\n');
  twoChoices.end();
  assert.equal(twoChoices.sample(), undefined);

  const nonzeroIndex = new ResponseSampler({ now: clock([100, 900]) });
  nonzeroIndex.feed(event({ id: 'm3', model: 'private', choices: [{ index: 1, delta: { content: 'he' } }] }));
  nonzeroIndex.feed(event({ id: 'm3', model: 'private', choices: [{ index: 1, delta: { content: 'llo' }, finish_reason: 'stop' }] }));
  nonzeroIndex.feed('data: [DONE]\n\n');
  nonzeroIndex.end();
  assert.equal(nonzeroIndex.sample(), undefined);
});

test('joins multiline SSE data split over data: lines until the blank separator', () => {
  const sampler = new ResponseSampler({ now: clock([100, 900]) });
  // Two logical events whose JSON payloads are each split across `data:` lines.
  const first = JSON.stringify({ id: 'ml', model: 'private', choices: [{ index: 0, delta: { content: 'he' } }] });
  const second = JSON.stringify({ id: 'ml', model: 'private', choices: [{ index: 0, delta: { content: 'llo' }, finish_reason: 'stop' }] });
  const splitPayload = (payload: string) => payload.replace(',"model"', ',\n"model"').replace(',"choices"', ',\n"choices"').split('\n');
  sampler.feed(splitPayload(first).map((part) => `data: ${part}`).join('\n') + '\n\n');
  sampler.feed(splitPayload(second).map((part) => `data: ${part}`).join('\n') + '\n\n');
  sampler.feed('data: [DONE]\n\n');
  sampler.end();
  const sample = sampler.sample();
  assert.ok(sample);
  assert.equal(sample.tps_samples[0]!.response_id, 'ml');
  assert.equal(sample.tps_samples[0]!.output_tokens, TOKENS_HELLO);
});

test('treats special-token lookalikes in generated text as ordinary text', () => {
  const special = '<' + '|endoftext|' + '>';
  const sampler = new ResponseSampler({ now: clock([100, 900]) });
  sampler.feed(event({ id: 'sp', model: 'private', choices: [{ delta: { content: 'a ' + special + ' ' } }] }));
  sampler.feed(event({ id: 'sp', model: 'private', choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }] }));
  sampler.feed('data: [DONE]\n\n');
  sampler.end();
  const sample = sampler.sample();
  assert.ok(sample);
  assert.ok(sample.tps_samples[0]!.output_tokens >= 2);
});

test('ignores tool calls with missing or empty arguments', () => {
  const sampler = new ResponseSampler({ now: clock([100, 900]) });
  sampler.feed(event({ id: 'ta', model: 'private', choices: [{ delta: { content: 'he' } }] }));
  // Neither the missing nor the empty arguments are generation content, so
  // this event consumes no clock tick and no tokens.
  sampler.feed(event({ id: 'ta', model: 'private', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup' } }, { index: 1, function: { arguments: '' } }] } }] }));
  sampler.feed(event({ id: 'ta', model: 'private', choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] }));
  sampler.feed('data: [DONE]\n\n');
  sampler.end();
  const sample = sampler.sample();
  assert.ok(sample);
  assert.equal(sample.tps_samples[0]!.output_tokens, TOKENS_HELLO);
  assert.equal(sample.tps_samples[0]!.first_token_at_ms, 100);
  assert.equal(sample.tps_samples[0]!.completed_at_ms, 900);
});

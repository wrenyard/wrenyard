import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WrenyardGatewayConnection, WrenyardGatewayModel } from '@wrenyard/control-client';
import {
  ConversationSummaryService,
  DEFAULT_SUMMARY_CANONICAL_MODEL,
  SummaryModelPreferenceStore,
  canonicalSummaryModelId,
  hasUsableSummaryProvider,
  resolveSummaryGatewayCandidate,
  summaryGatewayCandidates,
} from '../src/conversation-summary.js';

function model(
  provider: string,
  id: string,
  displayName: string,
): WrenyardGatewayModel {
  return {
    id,
    publicId: `${provider}/${id}`,
    provider,
    displayName,
    intelligence: 'mid',
  };
}

function connection(models: WrenyardGatewayModel[]): WrenyardGatewayConnection {
  return {
    openaiChatBaseUrl: 'http://127.0.0.1:9999/gateway/openai-chat/v1',
    openaiResponsesBaseUrl: 'http://127.0.0.1:9999/gateway/openai-chat/v1',
    anthropicBaseUrl: 'http://127.0.0.1:9999',
    token: 'gateway-token',
    models,
  };
}

function tempStore(): { store: SummaryModelPreferenceStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wrenyard-summary-'));
  return { store: new SummaryModelPreferenceStore(join(dir, 'conversation-summary.json')), dir };
}

test('gateway public ids resolve to the canonical summary identity', () => {
  // codebuddy carries deepseek-v4.1-flash with no canonicalModel entry: its
  // canonical identity is the provider-local id (never a label guess).
  assert.equal(canonicalSummaryModelId('codebuddy/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(canonicalSummaryModelId('kimi-coding/k3'), 'kimi-k3');
  assert.equal(canonicalSummaryModelId('zhipu-coding/glm-5.3'), 'glm-5.3');
  assert.equal(canonicalSummaryModelId('kimi-coding/kimi-k2.8'), 'kimi-k2.8');
});

test('candidate resolution keeps the selected model and rejects unavailable choices', () => {
  const snapshot = connection([
    model('kimi-coding', 'k3', 'Kimi K3'),
    model('zhipu-coding', 'glm-5.3', 'GLM 5.3'),
    model('codebuddy', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
  ]);

  // Canonical match.
  assert.equal(resolveSummaryGatewayCandidate(snapshot, 'kimi-k3')?.publicId, 'kimi-coding/k3');
  // Provider-local/exact model-id fallback.
  assert.equal(resolveSummaryGatewayCandidate(snapshot, 'glm-5.3')?.publicId, 'zhipu-coding/glm-5.3');
  // An available default must never replace an unavailable user choice.
  assert.equal(
    resolveSummaryGatewayCandidate(snapshot, 'does-not-exist'),
    undefined,
  );
  // No candidates at all → undefined, so the caller surfaces failure rather than substituting.
  assert.equal(resolveSummaryGatewayCandidate(connection([]), 'anything'), undefined);
});

test('a listed gateway model is the only usable-provider evidence', () => {
  const snapshot = connection([model('kimi-coding', 'k3', 'Kimi K3')]);
  assert.equal(hasUsableSummaryProvider(snapshot, 'kimi-k3'), true);
  // A provider directory entry is NOT evidence: an unlisted canonical model is unresolved.
  assert.equal(hasUsableSummaryProvider(snapshot, 'glm-5.3'), false);
  assert.equal(hasUsableSummaryProvider(connection([]), DEFAULT_SUMMARY_CANONICAL_MODEL), false);
});

test('candidates enumerate only provider/model gateway rows', () => {
  const snapshot = connection([
    model('kimi-coding', 'k3', 'Kimi K3'),
    model('codebuddy', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
  ]);
  const candidates = summaryGatewayCandidates(snapshot);
  assert.deepEqual(candidates.map((candidate) => candidate.publicId), [
    'kimi-coding/k3',
    'codebuddy/deepseek-v4.1-flash',
  ]);
  assert.equal(candidates[1]?.provider, 'codebuddy');
  assert.equal(candidates[1]?.model, 'deepseek-v4.1-flash');
});

test('preference persists the canonical model and defaults to DeepSeek V4.1 Flash', () => {
  const { store, dir } = tempStore();
  try {
    assert.equal(store.load(), DEFAULT_SUMMARY_CANONICAL_MODEL);
    assert.equal(store.save('kimi-k3'), 'kimi-k3');
    // A fresh store instance reads the persisted file (survives restart).
    const reloaded = new SummaryModelPreferenceStore(join(dir, 'conversation-summary.json'));
    assert.equal(reloaded.load(), 'kimi-k3');
    // Only the canonical id is persisted; no token/provider ever reaches disk.
    const raw = readFileSync(join(dir, 'conversation-summary.json'), 'utf8');
    assert.equal(raw.includes('gateway-token'), false);
    assert.equal(raw.includes('provider'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summary issues exactly one ordinary request carrying only summary context', async () => {
  const { store, dir } = tempStore();
  try {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '  已完成 A，正在做 B。  ' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const service = new ConversationSummaryService({
      readGatewayConnection: async () => connection([
        model('codebuddy', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
      ]),
      preferenceStore: store,
      fetchImpl,
    });

    const controller = new AbortController();
    const summary = await service.summarize({
      previousSummaries: [{ user: '上一轮问题', summary: '上一轮摘要' }],
      user: '本轮问题',
      work: '本轮工具输出',
      signal: controller.signal,
    });

    assert.equal(summary, '已完成 A，正在做 B。');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, 'http://127.0.0.1:9999/gateway/openai-chat/v1/chat/completions');
    const body = JSON.parse(String(requests[0]!.init.body)) as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    // The gateway expects provider/model, not a bare model id.
    assert.equal(body.model, 'codebuddy/deepseek-v4.1-flash');
    assert.equal(body.stream, true);
    assert.equal(body.messages.length, 4);
    const payload = JSON.stringify(body.messages);
    assert.equal(payload.includes('上一轮问题'), true);
    assert.equal(payload.includes('上一轮摘要'), true);
    assert.equal(payload.includes('本轮问题'), true);
    // The current work is carried, but no prior work transcript is replayed.
    assert.equal(payload.includes('本轮工具输出'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an aborted caller signal cancels the single in-flight request', async () => {
  const { store, dir } = tempStore();
  try {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
    const service = new ConversationSummaryService({
      readGatewayConnection: async () => connection([
        model('codebuddy', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
      ]),
      preferenceStore: store,
      fetchImpl,
    });

    const pending = service.summarize({
      previousSummaries: [],
      user: '问题',
      work: '工作',
      signal: controller.signal,
    });
    // Abort on the next tick so the in-flight request has registered its listener.
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
    controller.abort();
    await assert.rejects(pending, /取消/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('streamed visible deltas are collected once across fragmented frames', async () => {
  const { store, dir } = tempStore();
  try {
    const encoder = new TextEncoder();
    // The visible text is split mid multi-byte character, across frames, and the
    // reasoning delta must not reach the summary.
    const frame = (payload: string): string => `data: ${payload}\n\n`;
    const pieces = [
      'data: {"choices":[{"delta":{"reasoning_content":"内部思考不应出现"}}]}\r\n\r\n',
      frame('{"choices":[{"delta":{"content":"结论"}}]}'),
      'data: {"choices":[{"delta":{"content":"：字符"}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"串"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ];
    const bytes = encoder.encode(pieces.join(''));
    // One-byte chunks split both UTF-8 characters and CRLF boundaries.
    const fetchImpl: typeof fetch = async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controllerStream) {
          for (let index = 0; index < bytes.length; index += 1) {
            controllerStream.enqueue(bytes.slice(index, index + 1));
          }
          controllerStream.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const service = new ConversationSummaryService({
      readGatewayConnection: async () => connection([
        model('codebuddy', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
      ]),
      preferenceStore: store,
      fetchImpl,
    });

    const summary = await service.summarize({
      previousSummaries: [],
      user: '问题',
      work: '工作',
      signal: new AbortController().signal,
    });

    assert.equal(summary, '结论：字符串');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an SSE error payload fails the summary instead of returning partial text', async () => {
  const { store, dir } = tempStore();
  try {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'
          + 'data: {"error":{"code":11101,"message":"stream failed"}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    const service = new ConversationSummaryService({
      readGatewayConnection: async () => connection([
        model('codebuddy', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
      ]),
      preferenceStore: store,
      fetchImpl,
    });

    await assert.rejects(
      service.summarize({ previousSummaries: [], user: '问题', work: '工作', signal: new AbortController().signal }),
      /摘要请求失败：stream failed/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an abort during streamed body consumption still cancels the summary', async () => {
  const { store, dir } = tempStore();
  try {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = (_input, init) => new Promise<Response>((resolve) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controllerStream) {
          controllerStream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n'));
          signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            controllerStream.error(error);
          });
        },
      });
      resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    });
    const service = new ConversationSummaryService({
      readGatewayConnection: async () => connection([
        model('codebuddy', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'),
      ]),
      preferenceStore: store,
      fetchImpl,
    });

    const pending = service.summarize({
      previousSummaries: [],
      user: '问题',
      work: '工作',
      signal: controller.signal,
    });
    // Abort on a later tick so the stream body is already being consumed.
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
    controller.abort();
    await assert.rejects(pending, /取消/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unresolved provider surfaces a concise error instead of substituting a model', async () => {
  const { store, dir } = tempStore();
  try {
    store.save('glm-5.3');
    let called = false;
    const service = new ConversationSummaryService({
      readGatewayConnection: async () => connection([
        model('kimi-coding', 'k3', 'Kimi K3'),
      ]),
      preferenceStore: store,
      fetchImpl: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
    });
    await assert.rejects(
      service.summarize({ previousSummaries: [], user: '问题', work: '工作', signal: new AbortController().signal }),
      /没有可用于摘要的模型供应商/,
    );
    assert.equal(called, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { describe, expect, it } from 'vitest';
import { classifyWorkerClient, normalizeClientFamily } from '../src/main/client-family';

describe('client family classification', () => {
  it('uses cb-* profile before Claude-protocol client_family', () => {
    expect(classifyWorkerClient('cb-ds', 'claude')).toBe('codebuddy');
    expect(classifyWorkerClient('cb-dsf', 'claude')).toBe('codebuddy');
  });

  it('normalizes known client_family strings case-insensitively', () => {
    expect(normalizeClientFamily(' Claude ')).toBe('claude');
    expect(normalizeClientFamily('CODEX')).toBe('codex');
    expect(normalizeClientFamily('CodeBuddy')).toBe('codebuddy');
    expect(normalizeClientFamily('OpenCode')).toBe('codebuddy');
    expect(normalizeClientFamily('opencode')).toBe('codebuddy');
  });

  it('classifies codex from client_family or profile', () => {
    expect(classifyWorkerClient('unknown-profile', 'codex')).toBe('codex');
    expect(classifyWorkerClient('codex-spark')).toBe('codex');
    expect(classifyWorkerClient('codex', 'claude')).toBe('codex');
  });

  it('classifies CodeBuddy from client_family for non-CodeBuddy profiles', () => {
    expect(classifyWorkerClient('gpt-5', 'opencode')).toBe('codebuddy');
  });

  it('classifies Claude Code from client_family or profile', () => {
    expect(classifyWorkerClient('unknown-profile', 'claude')).toBe('claude');
    expect(classifyWorkerClient('claude-sonnet')).toBe('claude');
    expect(classifyWorkerClient('anthropic-opus')).toBe('claude');
    expect(classifyWorkerClient('cc')).toBe('claude');
    expect(classifyWorkerClient('ccb-ds')).toBe('claude');
    expect(classifyWorkerClient('ccg')).toBe('claude');
    expect(classifyWorkerClient('ccds')).toBe('claude');
  });

  it('falls back from profile when client_family is absent for CodeBuddy', () => {
    expect(classifyWorkerClient('cb-dsf')).toBe('codebuddy');
    expect(classifyWorkerClient('cb-ds')).toBe('codebuddy');
  });

  it('returns unknown for unsupported clients and profiles', () => {
    expect(classifyWorkerClient('unknown-profile', 'other-client')).toBe('unknown');
    expect(classifyWorkerClient('unknown-profile')).toBe('unknown');
  });
});

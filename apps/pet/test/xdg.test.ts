import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as xdg from '../scripts/lib/xdg.mjs';
import * as xdgTs from '../src/main/xdg';

const OLD_ENV = process.env;

describe('xdg (.mjs)', () => {
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  describe('configHome', () => {
    it('honors XDG_CONFIG_HOME when set', () => {
      process.env.XDG_CONFIG_HOME = '/custom/config';
      expect(xdg.configHome()).toBe('/custom/config');
    });

    it('defaults to ~/.config when XDG_CONFIG_HOME is unset', () => {
      delete process.env.XDG_CONFIG_HOME;
      const expected = join(homedir(), '.config');
      expect(xdg.configHome()).toBe(expected);
    });
  });

  describe('stateHome', () => {
    it('honors XDG_STATE_HOME when set', () => {
      process.env.XDG_STATE_HOME = '/custom/state';
      expect(xdg.stateHome()).toBe('/custom/state');
    });

    it('defaults to ~/.local/state when XDG_STATE_HOME is unset', () => {
      delete process.env.XDG_STATE_HOME;
      const expected = join(homedir(), '.local', 'state');
      expect(xdg.stateHome()).toBe(expected);
    });
  });

  describe('stateDir', () => {
    it('composes stateHome + wrenyard/pet', () => {
      process.env.XDG_STATE_HOME = '/custom/state';
      expect(xdg.stateDir()).toBe(join('/custom/state', 'wrenyard', 'pet'));
    });
  });

  describe('configDir', () => {
    it('composes configHome + wrenyard/pet', () => {
      process.env.XDG_CONFIG_HOME = '/custom/config';
      expect(xdg.configDir()).toBe(join('/custom/config', 'wrenyard', 'pet'));
    });
  });

  describe('log path composition', () => {
    it('logs/pet.log is under stateDir/logs', () => {
      process.env.XDG_STATE_HOME = '/custom/state';
      const logPath = join(xdg.stateDir(), 'logs', 'pet.log');
      expect(logPath).toBe(join('/custom/state', 'wrenyard', 'pet', 'logs', 'pet.log'));
    });
  });
});

describe('xdg (.ts)', () => {
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('configHome honors XDG_CONFIG_HOME', () => {
    process.env.XDG_CONFIG_HOME = '/custom/config';
    expect(xdgTs.configHome()).toBe('/custom/config');
  });

  it('stateHome honors XDG_STATE_HOME', () => {
    process.env.XDG_STATE_HOME = '/custom/state';
    expect(xdgTs.stateHome()).toBe('/custom/state');
  });

  it('configDir composes configHome + wrenyard/pet', () => {
    process.env.XDG_CONFIG_HOME = '/custom/config';
    expect(xdgTs.configDir()).toBe(join('/custom/config', 'wrenyard', 'pet'));
  });

  it('stateDir composes stateHome + wrenyard/pet', () => {
    process.env.XDG_STATE_HOME = '/custom/state';
    expect(xdgTs.stateDir()).toBe(join('/custom/state', 'wrenyard', 'pet'));
  });

  it('configHome defaults to ~/.config', () => {
    delete process.env.XDG_CONFIG_HOME;
    const expected = join(homedir(), '.config');
    expect(xdgTs.configHome()).toBe(expected);
  });

  it('stateHome defaults to ~/.local/state', () => {
    delete process.env.XDG_STATE_HOME;
    const expected = join(homedir(), '.local', 'state');
    expect(xdgTs.stateHome()).toBe(expected);
  });
});

describe('cross-module parity (mjs vs ts)', () => {
  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('resolves identical configDir/stateDir under XDG overrides', () => {
    process.env.XDG_CONFIG_HOME = '/custom/config';
    process.env.XDG_STATE_HOME = '/custom/state';
    expect(xdg.configDir()).toBe(xdgTs.configDir());
    expect(xdg.stateDir()).toBe(xdgTs.stateDir());
    expect(join(xdg.stateDir(), 'logs', 'pet.log')).toBe(
      join(xdgTs.stateDir(), 'logs', 'pet.log'),
    );
  });

  it('resolves identical configDir/stateDir defaults without XDG overrides', () => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_STATE_HOME;
    expect(xdg.configDir()).toBe(xdgTs.configDir());
    expect(xdg.stateDir()).toBe(xdgTs.stateDir());
  });
});

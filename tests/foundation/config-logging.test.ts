import { foundationEnv } from './fixtures.js';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  loadConfig,
  redactedConfig,
  ConfigError,
} from '../../src/config/index.js';
import { createLogger } from '../../src/logging/index.js';

const fixtureEnv = {
  ...foundationEnv,
  MONGODB_URI: 'mongodb://127.0.0.1:27017/test',
  REDIS_URL: 'redis://127.0.0.1:6379',
  OPERATOR_API_KEY: 'placeholder-operator-test-only',
  OPENAI_API_KEY: 'placeholder-openai-test-only',
};

describe('configuration', () => {
  it('applies defaults uses the research-configured default model', () => {
    const config = loadConfig(fixtureEnv);
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      SPEND_CAP_USD: 2,
      LOG_LEVEL: 'info',
    });
    expect(config.OPENAI_MODEL).toBe('gpt-6-luna');
    expect(
      loadConfig({ ...fixtureEnv, OPENAI_API_KEY: undefined }).OPENAI_API_KEY,
    ).toBeUndefined();
  });
  it('fails on missing required fields without printing provided secret values', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({
        ...fixtureEnv,
        OPERATOR_API_KEY: undefined,
        MONGODB_URI: 'fixture-sensitive-invalid-url',
      });
    } catch (error) {
      expect(String(error)).toContain('OPERATOR_API_KEY');
      expect(String(error)).not.toContain('fixture-sensitive-invalid-url');
      expect(String(error)).not.toContain(fixtureEnv.OPENAI_API_KEY);
    }
  });
  it.each([
    { HOST: '0.0.0.0' },
    { OPERATOR_API_KEY: 'short' },
    { SPEND_CAP_USD: '3' },
    { PORT: 'invalid' },
  ])('rejects unsafe config %j', (override) => {
    expect(() => loadConfig({ ...fixtureEnv, ...override })).toThrow(
      ConfigError,
    );
  });
  it('masks all credentials and credential-bearing connection URLs', () => {
    const config = loadConfig({
      ...fixtureEnv,
      MONGODB_URI:
        'mongodb://fixture-user:fixture-password@localhost:27017/test',
    });
    const safe = redactedConfig(config);
    for (const field of [
      'MONGODB_URI',
      'REDIS_URL',
      'OPERATOR_API_KEY',
      'OPENAI_API_KEY',
    ] as const) {
      expect(safe).not.toHaveProperty(field);
    }
    expect(JSON.stringify(safe)).not.toContain('fixture-password');
    expect(safe).toMatchObject({
      operatorApiKeyConfigured: true,
      operatorLoginConfigured: true,
      providerKeysConfigured: {
        openai: true,
        perplexity: false,
        gemini: false,
        anthropic: false,
      },
    });
  });
});

describe('logger redaction', () => {
  it('redacts nested keys, authorization headers, messages and child bindings', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger(loadConfig(fixtureEnv), destination);
    logger.info(
      {
        apiKey: 'fixture-field-value',
        headers: { authorization: 'Bearer fixture-header-value' },
        deep: {
          one: {
            two: {
              password: 'fixture-password-value',
              OPERATOR_API_KEY: 'fixture-operator-field',
              OPENAI_API_KEY: 'fixture-openai-field',
              authorization: 'fixture-deep-auth',
            },
          },
        },
      },
      `Message ${fixtureEnv.OPENAI_API_KEY}`,
    );
    logger
      .child({ nested: { apiKey: 'fixture-child-value' } })
      .info('Child test');
    for (const value of [
      'fixture-field-value',
      'fixture-header-value',
      'fixture-password-value',
      'fixture-operator-field',
      'fixture-openai-field',
      'fixture-deep-auth',
      'fixture-child-value',
      fixtureEnv.OPENAI_API_KEY,
    ])
      expect(output).not.toContain(value);
    expect(output).toContain('[REDACTED]');
  });
});

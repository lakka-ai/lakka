import { describe, expect, it } from 'vitest';
import { ConfigError } from '@lakka/contracts';
import { createLogger, REJECTED_EVENT, serializeError } from '../src/logger.ts';

const CANARY = 'canary-7f3a9c';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const destination = {
    write(chunk: string) {
      raw.push(chunk);
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  };
  const root = createLogger({ level: 'trace', service: 'test', destination });
  return { ...root, lines, text: () => raw.join('') };
}

describe('logger', () => {
  it('NF-S5: keeps allowlisted fields and drops everything else', () => {
    const { frameworkLogger, lines, text } = capture();
    frameworkLogger.info(
      { status_code: 200, prompt: CANARY, authorization: CANARY },
      'http.request',
    );
    expect(text()).not.toContain(CANARY);
    expect(lines[0]).toMatchObject({ msg: 'http.request', status_code: 200, dropped_fields: 2 });
  });

  it('NF-S5: drops nested objects even under allowlisted names', () => {
    const { frameworkLogger, text } = capture();
    frameworkLogger.info({ route: { secret: CANARY } }, 'evt.nested');
    expect(text()).not.toContain(CANARY);
  });

  it('NF-S5: replaces messages that are not event names', () => {
    const { frameworkLogger, lines, text } = capture();
    frameworkLogger.info(`user password is ${CANARY}`);
    expect(text()).not.toContain(CANARY);
    expect(lines[0]?.['msg']).toBe(REJECTED_EVENT);
  });

  it('NF-S5: discards printf-style interpolation arguments', () => {
    const { frameworkLogger, text } = capture();
    frameworkLogger.info('evt.interp %s', CANARY);
    expect(text()).not.toContain(CANARY);
  });

  it('NF-S5: filters child logger bindings', () => {
    const { frameworkLogger, lines, text } = capture();
    frameworkLogger.child({ apiKey: CANARY, request_id: 'r1' }).info('evt.child');
    expect(text()).not.toContain(CANARY);
    expect(lines[0]).toMatchObject({ request_id: 'r1' });
  });

  it('NF-S5: never logs the message of a third-party error', () => {
    const { logger, frameworkLogger, text } = capture();
    const err = Object.assign(new Error(`provider said: ${CANARY}\nsecond line ${CANARY}`), {
      code: 'ECONNREFUSED',
      requestBodyValues: { prompt: CANARY },
    });
    logger.error('provider.failed', { dependency: 'provider' }, err);
    frameworkLogger.error(err);
    frameworkLogger.error({ err }, err.message);
    expect(text()).not.toContain(CANARY);
  });

  it('keeps the message and code of our own errors', () => {
    const e = serializeError(new ConfigError('invalid configuration: LAKKA_API_PORT'));
    expect(e).toMatchObject({
      name: 'ConfigError',
      code: 'config_invalid',
      message: 'invalid configuration: LAKKA_API_PORT',
    });
    expect(e.stack).toMatch(/^\s+at /);
  });

  it('writes structured JSON with level label, service and timestamp', () => {
    const { logger, lines } = capture();
    logger.info('app.started', { port: 3000 });
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'test',
      msg: 'app.started',
      port: 3000,
    });
    expect(typeof lines[0]?.['time']).toBe('string');
  });
});

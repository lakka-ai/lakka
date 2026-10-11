import { describe, expect, it } from 'vitest';
import { isPrivateHostLiteral, isPublicAddress } from '../src/net/public-address.ts';

describe('what a workspace webhook may reach (ADR 0054)', () => {
  it('BG-10: private, loopback, link-local and metadata addresses are not public', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '::ffff:127.0.0.1',
      'not an address',
    ]) {
      expect({ address, public: isPublicAddress(address) }).toEqual({ address, public: false });
    }
  });

  it('BG-10: ordinary internet addresses are public', () => {
    for (const address of [
      '1.1.1.1',
      '8.8.8.8',
      '172.32.0.1',
      '2606:4700::1111',
      '::ffff:1.1.1.1',
    ]) {
      expect({ address, public: isPublicAddress(address) }).toEqual({ address, public: true });
    }
  });

  it('BG-10: a URL naming localhost or a private address is refused before anything resolves', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '[::1]', '10.0.0.2']) {
      expect({ host, private: isPrivateHostLiteral(host) }).toEqual({ host, private: true });
    }
    for (const host of ['hooks.slack.com', '1.1.1.1', 'example.com']) {
      expect({ host, private: isPrivateHostLiteral(host) }).toEqual({ host, private: false });
    }
  });
});

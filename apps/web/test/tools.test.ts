import { describe, expect, it } from 'vitest';
import { MCP_SERVER_NAME } from '@lakka/contracts';
import { originInput } from '../src/components/admin/tool-servers.tsx';
import { slugOf, splitCommand } from '../src/components/tools/server-dialog.tsx';
import { ApiError, notAllowedOrigin } from '../src/lib/api.ts';

describe('adding a tool server (TL-1)', () => {
  it('TL-1: the short name the model sees is made from the name people see', () => {
    expect(slugOf('GitHub')).toBe('github');
    expect(slugOf('Jira Cloud')).toBe('jira-cloud');
    expect(slugOf('  Data -- warehouse! ')).toBe('data-warehouse');
    const long = slugOf('A very long name for a tool server that goes on and on');
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(MCP_SERVER_NAME);
  });

  it('TL-1: a command line is the program and its arguments, quotes keeping spaces', () => {
    expect(splitCommand('/opt/tools/warehouse-mcp --read-only')).toEqual({
      command: '/opt/tools/warehouse-mcp',
      args: ['--read-only'],
    });
    expect(splitCommand('npx -y "my server" --port 3000')).toEqual({
      command: 'npx',
      args: ['-y', 'my server', '--port', '3000'],
    });
  });
});

describe('allowed tool server origins (NF-S4)', () => {
  it('NF-S4: only an origin is taken, with no path, query or credentials', () => {
    expect(originInput('https://mcp.example.com')).toBe('https://mcp.example.com');
    expect(originInput(' https://mcp.example.com/ ')).toBe('https://mcp.example.com/');
    expect(originInput('http://10.0.0.5:8080')).toBe('http://10.0.0.5:8080');
    for (const wrong of [
      'https://mcp.example.com/mcp',
      'https://mcp.example.com?x=1',
      'https://me@mcp.example.com',
      'ftp://mcp.example.com',
      'mcp.example.com',
      '*.example.com',
      '',
    ]) {
      expect(originInput(wrong)).toBeNull();
    }
  });

  it('NF-S4: the origin to allow is read from the refusal, and from nothing else', () => {
    const refusal = new ApiError(422, 'mcp_origin_not_allowed', 'not listed', {
      origin: 'https://mcp.example.com',
    });
    expect(notAllowedOrigin(refusal)).toBe('https://mcp.example.com');
    expect(notAllowedOrigin(new ApiError(422, 'mcp_origin_not_allowed', 'not listed'))).toBeNull();
    expect(notAllowedOrigin(new ApiError(409, 'mcp_server_exists', 'taken'))).toBeNull();
    expect(notAllowedOrigin(new Error('boom'))).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { modelDisplayName } from '../src/models.ts';

describe('model display names', () => {
  it('CH-2: names the fixtures models as the design does', () => {
    expect(modelDisplayName('claude-sonnet-4-5')).toBe('Claude Sonnet 4.5');
    expect(modelDisplayName('claude-haiku-4-5')).toBe('Claude Haiku 4.5');
    expect(modelDisplayName('gpt-4.1-mini')).toBe('GPT-4.1 mini');
    expect(modelDisplayName('llama3.3:70b')).toBe('Llama 3.3 70B');
  });

  it('CH-2: handles dates, versions in parts, short model families and unknown names', () => {
    expect(modelDisplayName('claude-3-5-sonnet-20240620')).toBe('Claude 3.5 Sonnet');
    expect(modelDisplayName('claude-fable-5')).toBe('Claude Fable 5');
    expect(modelDisplayName('gpt-4o-mini')).toBe('GPT-4o mini');
    expect(modelDisplayName('o3-mini')).toBe('o3 mini');
    expect(modelDisplayName('gemini-2.5-pro')).toBe('Gemini 2.5 Pro');
    expect(modelDisplayName('mistral-large-latest')).toBe('Mistral Large');
    expect(modelDisplayName('my-team-model')).toBe('My Team Model');
  });

  it('CH-2: names the families of DeepSeek, Moonshot, Qwen, Xiaomi and Z.ai models', () => {
    expect(modelDisplayName('deepseek-v4-pro')).toBe('DeepSeek V4 Pro');
    expect(modelDisplayName('kimi-k2.6')).toBe('Kimi K2.6');
    expect(modelDisplayName('glm-5.3-flash')).toBe('GLM 5.3 Flash');
    expect(modelDisplayName('mimo-v2.6-pro')).toBe('MiMo V2.6 Pro');
    expect(modelDisplayName('qwq-plus')).toBe('QwQ Plus');
    expect(modelDisplayName('qwen3-vl-32b-instruct')).toBe('Qwen 3 VL 32B instruct');
    // Active parameters of a mixture of experts, and a date written with dashes.
    expect(modelDisplayName('qwen3-next-80b-a3b-thinking')).toBe('Qwen 3 Next 80B A3B Thinking');
    expect(modelDisplayName('qwen-plus-2025-01-25')).toBe('Qwen Plus');
  });
});

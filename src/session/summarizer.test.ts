import { describe, it, expect } from 'vitest';
import type { Message } from '../llm/types.js';
import { estimateTokens, estimateTextTokens } from './summarizer.js';

/** 验证 CJK token 估算更接近真实成本 */
describe('session/summarizer token estimation', () => {
  it('CJK 文本按 1 字符≈1 token 估算', () => {
    const zh = '这是一个中文测试，用于估算 token。';
    const naive = Math.ceil(zh.length / 4);
    const fixed = estimateTextTokens(zh);
    const cjk = (zh.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
    const expected = cjk + Math.ceil((zh.length - cjk) / 4);
    expect(fixed).toBeGreaterThan(naive);
    expect(fixed).toBe(expected);
  });

  it('英文文本按 4 字符≈1 token 估算', () => {
    const en = 'This is an English sentence for token estimation.';
    const fixed = estimateTextTokens(en);
    const expected = Math.ceil(en.length / 4);
    expect(fixed).toBe(expected);
  });

  it('对话级估算：CJK 权重大于原逻辑', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: '你好，我想预约明天的会议' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好的，请问具体时间是几点？' }] },
    ];
    // 旧逻辑大致为长度/4
    const block0 = messages[0].content[0];
    const block1 = messages[1].content[0];
    const text0 = block0.type === 'text' ? block0.text : '';
    const text1 = block1.type === 'text' ? block1.text : '';
    const naive = Math.ceil(text0.length / 4)
      + Math.ceil(text1.length / 4)
      + 8;
    const fixed = estimateTokens(messages);
    expect(fixed).toBeGreaterThan(naive);
  });
});

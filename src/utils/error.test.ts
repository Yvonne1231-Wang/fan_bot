import { describe, it, expect } from 'vitest';
import { getErrorMessage } from './error.js';

describe('getErrorMessage', () => {
  it('应从 Error 实例提取 message', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error');
  });

  it('应从 TypeError 等子类提取 message', () => {
    expect(getErrorMessage(new TypeError('type err'))).toBe('type err');
  });

  it('应将字符串原样返回', () => {
    expect(getErrorMessage('raw string')).toBe('raw string');
  });

  it('应将数字转为字符串', () => {
    expect(getErrorMessage(42)).toBe('42');
  });

  it('应将 null/undefined 转为字符串', () => {
    expect(getErrorMessage(null)).toBe('null');
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  it('应将对象转为字符串', () => {
    expect(getErrorMessage({ code: 500 })).toBe('[object Object]');
  });
});

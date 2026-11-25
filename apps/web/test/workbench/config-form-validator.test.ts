// 平台配置校验测试：确保浏览器规则与后端确定性约束保持一致。
import { describe, expect, it } from 'vitest'
import {
  normalizeApiBaseUrl,
  validateConfigUpdate,
} from '../../src/modules/configuration/config-form-validator'

const validPayload = {
  projectDirectory: '/Users/test/workspace',
  llmApiKey: '',
  llmApiBaseUrl: 'https://api.example.com/v1/',
  llmModelName: 'provider-model',
}

describe('config-form-validator', () => {
  it('normalizes a valid provider-neutral update payload', () => {
    const result = validateConfigUpdate({
      ...validPayload,
      projectDirectory: '  /Users/test/workspace  ',
      llmModelName: '  provider-model  ',
    })

    expect(result.valid).toBe(true)
    expect(result.payload).toEqual({
      ...validPayload,
      llmApiBaseUrl: 'https://api.example.com/v1',
    })
  })

  it('reports required project, URL, and model fields', () => {
    const result = validateConfigUpdate({
      projectDirectory: ' ',
      llmApiKey: '',
      llmApiBaseUrl: ' ',
      llmModelName: ' ',
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toMatchObject({
      projectDirectory: '请先选择项目目录。',
      llmApiBaseUrl: '请先输入大模型 API 地址。',
      llmModelName: '请先输入大模型模型名称。',
    })
  })

  it.each([
    ['ftp://api.example.com/v1', '大模型 API 地址只支持 HTTP 或 HTTPS。'],
    [
      'http://api.example.com/v1',
      '大模型 API 地址必须使用 HTTPS，仅本机 loopback 地址允许 HTTP。',
    ],
    [
      'https://user:pass@api.example.com/v1',
      '大模型 API 地址不能包含用户名或密码。',
    ],
    [
      'https://api.example.com/v1?key=value',
      '大模型 API 地址不能包含 query 或 fragment。',
    ],
    [
      'https://api.example.com/v1#section',
      '大模型 API 地址不能包含 query 或 fragment。',
    ],
    [
      'https://api.example.com/v1/chat/completions',
      '大模型 API 地址应填写 API 根地址，而不是完整的 chat/completions 地址。',
    ],
  ])('rejects invalid API root %s', (value, expectedError) => {
    expect(normalizeApiBaseUrl(value)).toEqual({
      value: '',
      error: expectedError,
    })
  })

  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:8080/v1',
    'http://[::1]:8080/v1',
  ])('allows loopback HTTP URL %s', (value) => {
    expect(normalizeApiBaseUrl(value).error).toBeUndefined()
  })
})

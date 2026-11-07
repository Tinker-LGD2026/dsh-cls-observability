import { describe, expect, it } from 'vitest'
import { BUILTIN_RULES, Redactor, buildRedactor } from '../src/redact.ts'
import { Truncator } from '../src/semconv.ts'

const r = new Redactor(BUILTIN_RULES)
const run = (s: string) => { const hits = new Set<string>(); return { out: r.text(s, hits), hits: [...hits].sort() } }
// Fake credentials assembled at runtime so no secret scanner mistakes this file for a leak.
const fake = (prefix: string, n: number, alphabet = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z') =>
  prefix + Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join('')

describe('redaction', () => {
  it('masks credentials with a recognisable shape', () => {
    const cases: [string, string][] = [
      [`export TENCENTCLOUD_SECRET_ID=${fake('AKID', 32)}`, 'tencentcloud_secret_id'],
      [`aws ${fake('AKIA', 16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')} configured`, 'aws_access_key'],
      [`token ${fake('ghp_', 36)}`, 'github_token'],
      [`OPENAI ${fake('sk-proj-', 40)}`, 'api_key'],
      [`deepseek key: ${fake('sk-', 32)}`, 'api_key'],
      [`curl -H "Authorization: Bearer ${fake('', 40)}"`, 'authorization'],
      [`postgres://admin:${fake('', 12)}@db.internal:5432/app`, 'url_credentials'],
      [`jwt=${fake('eyJ', 20)}.${fake('eyJ', 30)}.${fake('', 24)}`, 'jwt'],
      [`-----BEGIN RSA PRIVATE KEY-----\n${fake('', 64)}\n-----END RSA PRIVATE KEY-----`, 'private_key'],
    ]
    for (const [input, rule] of cases) {
      const { out, hits } = run(input)
      expect(out, input).toContain('[REDACTED:')
      expect(hits, input).toContain(rule)
    }
  })

  it('keeps the key and masks the value of credential assignments', () => {
    expect(run('TENCENTCLOUD_SECRET_KEY=abcdEFGH1234ijkl').out).toBe('TENCENTCLOUD_SECRET_KEY=[REDACTED:assignment]')
    expect(run('"password": "hunter2hunter2"').out).toBe('"password": "[REDACTED:assignment]"')
    expect(run('db_password: s3cr3t-value').out).toBe('db_password: [REDACTED:assignment]')
    expect(run('api_key = "0123456789abcdef"').out).toBe('api_key = "[REDACTED:assignment]"')
    expect(run('password=correcthorsebattery').out).toBe('password=[REDACTED:assignment]')
    expect(run('PASSWORD: Correcthorsebattery').out).toBe('PASSWORD: [REDACTED:assignment]')
  })

  it('leaves ordinary content alone', () => {
    const benign = [
      'Run npm test, then git commit -m "fix token parsing"',
      'commit 8cd447c3f1e9a2b4c5d6e7f8091a2b3c4d5e6f70',
      'session-b99e6dba-6455-46e8-a67e-a649c3674fb3',
      'sha256=daeb2c8ce8230a9f33ae64b97d5f6ffc3d347c7a2c76972a21f26fc8ab821468',
      'The password field must be at least 8 characters.',
      'const token = getToken()',
      'password = config.password',
      'api_key = os.environ["DEEPSEEK_API_KEY"]',
      'secret: undefined',
      'token: required',
      'readonly token: PtcPermitToken;',
      'apiKey: string',
      'Authorization header is missing',
      'https://cloud.tencent.com/document/product/614/136743',
      'max_tokens: 4096',
      'input_tokens=8615 output_tokens=263',
    ]
    for (const text of benign) expect(run(text).out, text).toBe(text)
  })

  it('masks values under credential-named keys in structured arguments', () => {
    const hits = new Set<string>()
    const out = r.value({
      url: 'https://x.test',
      headers: { 'X-Api-Key': 'k1234567' },
      password: 'pw',
      nested: [{ client_secret: 'abc' }],
      max_tokens: 100,
    }, hits)
    expect(out).toEqual({
      url: 'https://x.test',
      headers: { 'X-Api-Key': '[REDACTED:key]' },
      password: '[REDACTED:key]',
      nested: [{ client_secret: '[REDACTED:key]' }],
      max_tokens: 100,
    })
    expect([...hits]).toEqual(['key'])
  })

  it('redacts before truncating, so a cut never exposes part of a secret', () => {
    const t = new Truncator(30, r)
    const out = t.text(`xxxxxxxxxxxxxxxxxxxx ${fake('AKID', 32)}`)
    expect(out).not.toMatch(/AKID/)
    expect(t.marks()).toMatchObject({ 'agent.custom.content_redacted': true, 'agent.custom.redacted_types': ['tencentcloud_secret_id'] })
  })

  it('can be switched off and extended with custom patterns', () => {
    const warnings: string[] = []
    expect(buildRedactor('off', undefined, (m) => warnings.push(m))).toBeUndefined()
    const custom = buildRedactor(undefined, JSON.stringify(['EMP-\\d{6}', '(']), (m) => warnings.push(m))!
    const hits = new Set<string>()
    expect(custom.text('employee EMP-123456', hits)).toBe('employee [REDACTED:custom]')
    expect(warnings.join()).toMatch(/invalid redaction pattern/)
    buildRedactor(undefined, 'not json', (m) => warnings.push(m))
    expect(warnings.join()).toMatch(/must be a JSON array/)
  })

  it('stays fast on large content', () => {
    const big = 'lorem ipsum dolor sit amet '.repeat(40_000)
    const start = performance.now()
    run(big)
    expect(performance.now() - start).toBeLessThan(200)
  })
})

import { describe, expect, it } from 'vitest'
import { BUILTIN_RULES, Redactor, buildRedactor, isMaskableSecret, secretsFromEnv } from '../src/redact.ts'
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

  it('masks credential-named keys in tool-call arguments inside messages, leaving other arguments verbatim', () => {
    const t = new Truncator(10_000, r)
    expect(t.json('{"url": "https://x", "password": "Summer"}')).toBe('{"url":"https://x","password":"[REDACTED:key]"}')
    expect(t.json('{ "path": "a.txt" }')).toBe('{ "path": "a.txt" }')
    expect(t.json('not json password=correcthorse')).toBe('not json password=[REDACTED:assignment]')
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

  it('masks more vendor formats', () => {
    const cases: [string, string][] = [
      [`ak ${fake('LTAI', 20)}`, 'alibaba_access_key'],
      [`volc ${fake('AKLT', 44)}`, 'volcengine_access_key'],
      [`DefaultEndpointsProtocol=https;AccountName=a;AccountKey=${fake('', 64)}==;EndpointSuffix=core.windows.net`, 'azure_key'],
      [`HF ${fake('hf_', 34)}`, 'huggingface_token'],
      [`stripe ${fake('sk_live_', 24)}`, 'api_key'],
      [`openrouter ${fake('sk-or-v1-', 40)}`, 'api_key'],
    ]
    for (const [input, rule] of cases) {
      const { out, hits } = run(input)
      expect(out, input).toContain('[REDACTED:')
      expect(hits, input).toContain(rule)
    }
  })

  it('masks command-line flags and Chinese wording, keeping the key', () => {
    const k = fake('', 32)
    expect(run(`tccli cvm DescribeInstances --secretKey ${k} --region ap-shanghai`).out).toBe('tccli cvm DescribeInstances --secretKey [REDACTED:cli_flag] --region ap-shanghai')
    expect(run(`mysql --password "${k}" -u root`).out).toBe('mysql --password "[REDACTED:cli_flag]" -u root')
    expect(run(`密钥是 ${k}，请保存`).out).toBe('密钥是 [REDACTED:assignment]，请保存')
    expect(run(`数据库密码：${k}`).out).toBe('数据库密码：[REDACTED:assignment]')
    expect(run(`SecretKey：${k}`).out).toBe('SecretKey：[REDACTED:assignment]')
    expect(run(`API 令牌为 “${k}”`).out).toBe('API 令牌为 “[REDACTED:assignment]”')
  })

  it('leaves code and prose around those wordings alone', () => {
    const benign = [
      'mysql --password $DB_PASSWORD -u root',
      'deploy --token "${{ secrets.DEPLOY_TOKEN }}"',
      'cli --api-key --verbose',
      '密码为空',
      '请输入密码：',
      '密钥是什么意思？',
      '密码 = getPassword()',
      'token: string;',
      'password=$PASSWORD',
    ]
    for (const text of benign) expect(run(text).out, text).toBe(text)
  })

  it('masks known secret values wherever they appear, and follows rotation', () => {
    const key = fake('', 32)
    let current = [key]
    const known = new Redactor(BUILTIN_RULES, () => current)
    const hits = new Set<string>()
    expect(known.text(`env 输出：${key}`, hits)).toBe('env 输出：[REDACTED:known_secret]')
    expect(known.text(`x${key}y`, hits)).toBe('x[REDACTED:known_secret]y')
    expect([...hits]).toEqual(['known_secret'])
    const rotated = fake('Z', 31)
    current = [rotated]
    expect(known.text(`old ${key} new ${rotated}`, new Set())).toBe(`old ${key} new [REDACTED:known_secret]`)
    // Values too plain to mask safely are ignored.
    expect(new Redactor([], () => ['password', '12345678', 'short']).text('password 12345678 short', new Set())).toBe('password 12345678 short')
  })

  it('takes credential values from the environment, not paths, settings or plain words', () => {
    const env = {
      DEEPSEEK_API_KEY: fake('sk-', 32),
      TENCENTCLOUD_SECRET_KEY: fake('', 32),
      GITHUB_TOKEN: fake('ghp_', 36),
      DB_PASSWORD: 'Hunter2Hunter2',
      GOOGLE_APPLICATION_CREDENTIALS: '/etc/gcp/key.json',
      CLS_AGENTOBS_CREDENTIALS_FILE: '/run/secrets/cls',
      TOKENIZERS_PARALLELISM: 'false',
      MAX_TOKENS: '4096',
      SECRET_MODE: 'strict-mode-on',
      API_KEY_URL: 'https://vault.internal/keys',
      PATH: '/usr/bin',
      HOME: '/root',
    }
    expect(secretsFromEnv(env).sort()).toEqual([env.DB_PASSWORD, env.DEEPSEEK_API_KEY, env.GITHUB_TOKEN, env.TENCENTCLOUD_SECRET_KEY].sort())
    expect(isMaskableSecret('development')).toBe(false)
    expect(isMaskableSecret('changeme123')).toBe(true)
  })

  it('has no rule that backtracks on adversarial input (each under 50 ms on 100 KB)', () => {
    const inputs = ['a.'.repeat(50_000), 'x-'.repeat(50_000), 'abc '.repeat(25_000), 'token='.repeat(16_000), 'password '.repeat(11_000),
      '--token '.repeat(12_500), 'a'.repeat(100_000), 'Bearer '.repeat(14_000), 'eyJabcdefgh.'.repeat(8_000), '密码是'.repeat(30_000),
      'a://'.repeat(25_000), 'http://u:'.repeat(11_000), `${'x'.repeat(50_000)}@`]
    for (const rule of BUILTIN_RULES) {
      const one = new Redactor([rule])
      for (const input of inputs) {
        const start = performance.now()
        one.text(input, new Set())
        expect(performance.now() - start, `${rule.name} on ${input.slice(0, 12)}…`).toBeLessThan(50)
      }
    }
  })

  it('redacts only what is kept from huge content, and still masks a secret at the cut', () => {
    const t = new Truncator(1000, r)
    const key = fake('AKID', 32)
    const out = t.text(`${'z'.repeat(990)} ${key} ${'q'.repeat(2_000_000)}`)
    expect(out).not.toContain(key.slice(0, 10))
    expect(out).toMatch(/…\[truncated \d+ chars\]$/)
    expect(Number(/truncated (\d+)/.exec(out)![1])).toBeGreaterThan(2_000_000 - 100)
  })

  it('stays fast on large content', () => {
    const big = 'lorem ipsum dolor sit amet '.repeat(40_000)
    const start = performance.now()
    run(big)
    expect(performance.now() - start).toBeLessThan(200)
  })
})

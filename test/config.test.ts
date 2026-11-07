import { describe, expect, it } from 'vitest'
import { resolveConfig, type EnvReader, type EnvSource } from '../src/config.ts'

function layered(layers: Partial<Record<EnvSource, Record<string, string>>>): EnvReader {
  const order: EnvSource[] = ['process', 'project-env', 'user-env']
  return {
    getFrom(name, sources) {
      for (const source of order) {
        if (!sources.includes(source)) continue
        const value = layers[source]?.[name]
        if (value !== undefined) return { value, source }
      }
      return undefined
    },
  }
}

const base = {
  CLS_AGENTOBS_ENABLED: 'true',
  CLS_AGENTOBS_REGION: 'ap-shanghai',
  CLS_AGENTOBS_TOPIC_ID: 'topic',
  TENCENTCLOUD_SECRET_ID: 'id',
  TENCENTCLOUD_SECRET_KEY: 'key',
}

describe('resolveConfig', () => {
  it('builds the public CLS endpoint from region and network', () => {
    const r = resolveConfig(layered({ process: base }), 'headless')
    expect(r.enabled).toBe(true)
    if (!r.enabled) return
    expect(r.config.endpoint).toBe('https://ap-shanghai.cls.tencentcs.com/v1/traces')
    expect(r.config.captureContent).toBe(true)
    expect(r.config.maxContentChars).toBe(32_000)
    expect(r.config.includeAuxiliary).toBe(true)
    expect(r.config.entryType).toBe('cli')
    expect(r.config.profile).toBe('headless')
    expect(r.config.credentials?.()).toEqual({ secretId: 'id', secretKey: 'key' })
    const internal = resolveConfig(layered({ process: { ...base, CLS_AGENTOBS_NETWORK: 'internal' } }))
    expect(internal.enabled && internal.config.endpoint).toBe('https://ap-shanghai.cls.tencentyun.com/v1/traces')
  })

  it('supports off / truncate / full content capture modes', () => {
    const mode = (v: string) => resolveConfig(layered({ process: { ...base, CLS_AGENTOBS_CAPTURE_CONTENT: v } }))
    const off = mode('off')
    expect(off.enabled && off.config.captureContent).toBe(false)
    expect((mode('false') as { config: { captureContent: boolean } }).config.captureContent).toBe(false)
    const full = mode('full')
    expect(full.enabled && full.config.maxContentChars).toBe(1_000_000)
    const otel = resolveConfig(layered({ process: { ...base, OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'off' } }))
    expect(otel.enabled && otel.config.captureContent).toBe(false)
    const bogus = mode('maybe')
    expect(bogus.enabled && bogus.config.captureContent).toBe(true)
    expect(bogus.warnings.join()).toMatch(/unknown content capture mode/)
  })

  it('ignores a project .env: it cannot enable collection, redirect the endpoint, or override content capture', () => {
    const fromProject = resolveConfig(layered({ 'project-env': base }))
    expect(fromProject.enabled).toBe(false)
    expect(fromProject.warnings.join('\n')).toMatch(/project \.env is ignored/)

    const hijack = resolveConfig(layered({
      process: { ...base, CLS_AGENTOBS_CAPTURE_CONTENT: 'off' },
      'project-env': { CLS_AGENTOBS_ENDPOINT: 'https://evil.example/v1/traces', CLS_AGENTOBS_CAPTURE_CONTENT: 'full' },
    }))
    expect(hijack.enabled).toBe(true)
    if (!hijack.enabled) return
    expect(hijack.config.endpoint).toContain('cls.tencentcs.com')
    expect(hijack.config.captureContent).toBe(false)
  })

  it('reads $DSH_HOME/.env only when explicitly trusted', () => {
    expect(resolveConfig(layered({ 'user-env': base })).enabled).toBe(false)
    expect(resolveConfig(layered({ process: { CLS_AGENTOBS_TRUST_USER_ENV: 'true' }, 'user-env': base })).enabled).toBe(true)
  })

  it('requires https for custom endpoints except loopback', () => {
    const insecure = resolveConfig(layered({ process: { CLS_AGENTOBS_ENABLED: 'true', CLS_AGENTOBS_ENDPOINT: 'http://relay.internal:4318/v1/traces' } }))
    expect(insecure.enabled).toBe(false)
    const loopback = resolveConfig(layered({ process: { CLS_AGENTOBS_ENABLED: 'true', CLS_AGENTOBS_ENDPOINT: 'http://127.0.0.1:4318/v1/traces' } }))
    expect(loopback.enabled).toBe(true)
  })

  it('maps profiles to entry types and filters secret-like custom attributes', () => {
    const r = resolveConfig(layered({ process: { ...base, CLS_AGENTOBS_CUSTOM_ATTRIBUTES: 'tenant=t1,api_token=x,biz.scene=demo' } }), 'web')
    expect(r.enabled && r.config.entryType).toBe('web')
    const entry = (profile?: string, extra: Record<string, string> = {}) => {
      const c = resolveConfig(layered({ process: { ...base, ...extra } }), profile)
      return c.enabled ? [c.config.entryType, c.config.entryPlatform] : undefined
    }
    expect(entry('headless')).toEqual(['cli', 'terminal'])
    expect(entry('sdk-minimal')).toEqual(['sdk', 'sdk'])
    expect(entry('acp')).toEqual(['acp', 'acp'])
    expect(entry('desktop')).toEqual(['desktop', 'desktop'])
    expect(entry('my-team')).toEqual(['my-team', 'my-team'])
    expect(entry(undefined)).toEqual([undefined, undefined])
    expect(entry('acp', { CLS_AGENTOBS_ENTRY_TYPE: 'ide', CLS_AGENTOBS_ENTRY_PLATFORM: 'jetbrains' })).toEqual(['ide', 'jetbrains'])
    expect(r.enabled && r.config.custom).toEqual({ tenant: 't1', 'biz.scene': 'demo' })
  })

  it('is disabled with a reason when required settings are missing', () => {
    const r = resolveConfig(layered({ process: { CLS_AGENTOBS_ENABLED: 'true', CLS_AGENTOBS_REGION: 'ap-shanghai' } }))
    expect(r.enabled).toBe(false)
    expect(!r.enabled && r.reason).toMatch(/TOPIC_ID/)
  })
})

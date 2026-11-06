function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]))
  return value
}

export async function migrationSha(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export const migrationFingerprint = (value: unknown): Promise<string> => migrationSha(new TextEncoder().encode(JSON.stringify(canonical(value))))

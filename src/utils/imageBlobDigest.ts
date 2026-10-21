// Blob bytes are immutable. Cache only their digest, never a full image buffer;
// each observer still owns its independent source/session validity checks.
const digests = new WeakMap<Blob, Promise<string>>()
export async function imageBlobDigest(blob: Blob, check: () => void) {
  check()
  let digest = digests.get(blob)
  if (!digest) {
    digest = blob.arrayBuffer().then(bytes => crypto.subtle.digest('SHA-256', bytes))
      .then(bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join(''))
    digests.set(blob, digest)
    void digest.catch(() => { if (digests.get(blob) === digest) digests.delete(blob) })
  }
  const sha256 = await digest
  check()
  return { sha256 }
}

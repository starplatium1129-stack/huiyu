/** The caller owns source/session validity around both asynchronous reads. */
export async function imageBlobDigest(blob: Blob, check: () => void) {
  check()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  check()
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(value => value.toString(16).padStart(2, '0')).join('')
  check()
  return { bytes, sha256 }
}

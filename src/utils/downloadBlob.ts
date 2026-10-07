/** Keep the object URL alive long enough for the browser to start reading large downloads. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  let anchor: HTMLAnchorElement | undefined
  let started = false
  try {
    anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    document.body.appendChild(anchor)
    anchor.click()
    started = true
  } finally {
    try { anchor?.remove() } finally {
      if (started) window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      else URL.revokeObjectURL(url)
    }
  }
}

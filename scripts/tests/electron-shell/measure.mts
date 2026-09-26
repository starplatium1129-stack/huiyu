import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
const require = createRequire(import.meta.url)
export const windows = require('../desktop-native/windows.js') as typeof import('../desktop-native/windows.js')

export function directoryBytes(root: string): number {
  let total = 0
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) total += directoryBytes(file)
    else if (entry.isFile()) total += fs.statSync(file).size
  }
  return total
}
function cpu(pids: number[]) {
  const ids = pids.filter(pid => Number.isSafeInteger(pid) && pid > 0).join(',')
  return JSON.parse(windows.powershell(`
$items = @(Get-Process -Id @(${ids}) -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ pid=$_.Id; cpuMs=$_.TotalProcessorTime.TotalMilliseconds }
})
[pscustomobject]@{ time=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); items=$items } | ConvertTo-Json -Depth 4 -Compress
`)) as { time: number; items: { pid: number; cpuMs: number }[] }
}
export async function measure(rootPid: number, sampleMs: number) {
  const beforeTree = windows.sampleProcessTree(rootPid)
  const ids = beforeTree.processes.map((process: { pid: number }) => process.pid)
  const before = cpu(ids)
  await delay(sampleMs)
  const after = cpu(ids)
  const beforeValues = new Map(before.items.map(process => [process.pid, process.cpuMs]))
  const cpuMs = after.items.reduce((sum, process) => sum + Math.max(0, process.cpuMs - (beforeValues.get(process.pid) ?? process.cpuMs)), 0)
  return { ...windows.sampleProcessTree(rootPid), sampleWallMs: after.time - before.time, cpuMs,
    cpuCorePercent: cpuMs / (after.time - before.time) * 100,
    cpuScope: 'same surviving process-tree PIDs; 100% equals one logical core',
    beforeProcessCount: beforeTree.processCount }
}

'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const manifestPath = path.join(root, 'tests', 'e2e', 'e2e-lanes.json');

interface LaneManifestEntry {
  file: string;
  lane: string;
  risk: string;
  reason: string;
}

interface LaneManifest {
  schemaVersion: number;
  specs: LaneManifestEntry[];
}

function loadLaneManifest(): LaneManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function getSpecsForLane(lane: string): string[] {
  const manifest = loadLaneManifest();
  return manifest.specs
    .filter((entry: LaneManifestEntry) => entry.lane === lane)
    .map((entry: LaneManifestEntry) => entry.file)
    .sort();
}

function runE2eLane(lane: string, extraArgs: string[] = []): number {
  const specFiles = getSpecsForLane(lane);
  if (!specFiles.length) {
    console.error(`[run-e2e-lane] No specs found for lane "${lane}".`);
    return 1;
  }
  const specPaths = specFiles.map((file: string) => `tests/e2e/${file}`);
  const cliPath = require.resolve('@playwright/test/cli');
  const result = spawnSync(process.execPath, [cliPath, 'test', ...specPaths, ...extraArgs], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    console.error('[run-e2e-lane] Failed to spawn playwright:', result.error);
    return 1;
  }
  return result.status ?? (result.signal ? 1 : 0);
}

if (require.main === module) {
  const lane = process.argv[2];
  if (!lane) {
    console.error('Usage: node scripts/tests/run-e2e-lane.js <lane> [playwright-args...]');
    process.exit(1);
  }
  const extraArgs = process.argv.slice(3);
  const exitCode = runE2eLane(lane, extraArgs);
  process.exit(exitCode);
}

const exportsObject = {
  loadLaneManifest,
  getSpecsForLane,
  runE2eLane,
};

export = exportsObject;

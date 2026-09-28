// Test-only Node oracle. Installer roots/policy come exclusively from the
// disposable Rust fixture passed on stdin; no application config is loaded.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const source = path.resolve(root, '../scripts/lib');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const policy = require(path.join(source, 'resource-install-policy.js'));
const { manifestContentIdentity } = require(path.join(source, 'resource-pack-delta.js'));
const { verifyDeltaPackContent } = require(path.join(source, 'resource-pack-verify.js'));
async function main() {
  if (input.workflow) {
    const installer = require(path.join(source, 'resource-install.js')).createResourceInstaller({
      userDataRoot: input.userDataRoot, protectedRoots: [input.appRoot], policy: input.policy,
      access: { isLocalStudioHost: () => true, isAuthorized: () => true }
    });
    await installer.install({ releaseId: 'A' });
    await installer.install({ releaseId: 'B' });
    const result = await installer.rollback();
    return result.state;
  }
  return { identity: manifestContentIdentity(input.base), delta: verifyDeltaPackContent(input).ok,
    target: policy.targetManifest({ manifest: input.packManifest, delta: input.delta }, input.baseManifest, { targetIdentity: input.delta.newManifest.contentIdentity }),
    forms: input.forms.map(value => { try { return { value: policy.manifest(value) }; } catch(error) { return { code: error.code }; } }) };
}
main().then(value => process.stdout.write(JSON.stringify(value))).catch(error => { console.error(error); process.exitCode=1; });

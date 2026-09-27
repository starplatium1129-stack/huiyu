# Tauri NSIS template provenance

`tauri-2.12.0.nsi` is the unmodified upstream template from the installed CLI version:

https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.0/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi

SHA-256: `dabed59013b1d78b879a1a85bc7f2eed2993b33a9a90cdabe5946de3d3950597`.

Tauri is dual licensed under MIT or Apache-2.0; this vendored copy is used under the MIT license in LICENSE.txt. Presentation patches are applied by scripts/maintenance/build-game-installer.js, with anchor and hash checks. On a Tauri upgrade, deliberately review a new upstream template and update the pin; do not silently regenerate from a different version.

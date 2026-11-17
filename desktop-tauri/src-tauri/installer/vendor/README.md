# Tauri NSIS template provenance

`tauri-2.12.5.nsi` is the unmodified upstream template from the installed CLI version:

https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.5/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi

SHA-256: `d00089d3b1a2c4a30d7b6e098079100cb8f25e980f84d4515aca4597b95e967d`.

Tauri is dual licensed under MIT or Apache-2.0; this vendored copy is used under the MIT license in LICENSE.txt. Presentation patches are applied by scripts/maintenance/build-game-installer.js, with anchor and hash checks. On a Tauri upgrade, deliberately review a new upstream template and update the pin; do not silently regenerate from a different version.

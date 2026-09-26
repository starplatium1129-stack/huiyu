'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function createPreferences(config, safeStorage) {
  const file = path.join(config.configRoot, 'electron-shell.json');
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const state = { alwaysOnTop: stored.alwaysOnTop === true, ignoreMouseEvents: stored.ignoreMouseEvents === true,
    live2dEnabled: typeof stored.live2dEnabled === 'boolean' ? stored.live2dEnabled : true, chatDocked: stored.chatDocked !== false,
    zoom: stored.zoom && typeof stored.zoom === 'object' ? stored.zoom : {}, credentials: stored.credentials && typeof stored.credentials === 'object' ? stored.credentials : {} };
  function save() {
    const temporary = file + '.tmp'; fs.writeFileSync(temporary, JSON.stringify(state)); fs.renameSync(temporary, file);
  }
  function endpointKey(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 2048) throw Error('Invalid credential endpoint');
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid credential endpoint');
    url.hash = ''; return crypto.createHash('sha256').update(url.href.replace(/\/$/, '')).digest('hex');
  }
  function encryption() { if (!safeStorage.isEncryptionAvailable()) throw Error('UNSUPPORTED: secure credential storage unavailable'); }
  return { state, save,
    readCredential(endpoint) { encryption(); const encrypted = state.credentials[endpointKey(endpoint)]; return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : null; },
    writeCredential(endpoint, secret) {
      encryption(); if (typeof secret !== 'string' || secret.length > 16_384) throw Error('Invalid credential value');
      const key = endpointKey(endpoint);
      if (secret) state.credentials[key] = safeStorage.encryptString(secret).toString('base64'); else delete state.credentials[key];
      save();
    },
  };
}
module.exports = { createPreferences };

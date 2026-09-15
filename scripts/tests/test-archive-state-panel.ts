'use strict';

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

test('archive state language contract', () => {
  const root = path.resolve(__dirname, '..', '..');
  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
  const panel = read('src/components/visual/ArchiveStatePanel.vue');
  const scene = read('src/views/SceneExplorerView.vue');
  const gallery = read('src/views/GalleryView.vue');
  const showcase = read('src/views/ShowcaseView.vue');
  const character = read('src/views/CharacterView.vue');
  const home = read('src/views/HomeView.vue');

  assert(panel.includes("'loading' | 'empty' | 'filtered' | 'error' | 'success'"), 'state union must distinguish filtered results');
  assert(panel.includes("filtered:'search'"), 'filtered state must use a search icon');
  assert(panel.includes('v-if="code"'), 'optional diagnostic codes must stay hidden unless supplied');
  assert(panel.includes(':data-kind="kind"'), 'state kind must be exposed for styling and tests');
  assert(panel.includes(':aria-busy="kind === \'loading\' ? \'true\' : undefined"'), 'loading states must expose aria-busy');
  assert(panel.includes("props.kind === 'loading' ? 'status'"), 'loading must remain a status announcement');
  // f232ed1 起新增 warning 级别：error 与 warning 同样以 alert 角色播报
  assert(panel.includes("props.kind === 'error' || props.kind === 'warning'"), 'errors (and warnings) must remain alerts');
  assert(panel.includes('compact?: boolean') && panel.includes('.archive-state-panel.compact'), 'compact state contract must be supported');
  assert(panel.includes('[data-kind="loading"] { --state-accent:var(--archive-blue); }'), 'loading must keep the archive accent');
  assert(panel.includes('[data-kind="error"] { --state-accent:var(--danger-text); }'), 'errors must use the danger accent');
  assert(panel.includes('[data-kind="success"] { --state-accent:var(--success-text); }'), 'success must use the success accent');

  assert(scene.includes('v-else-if="paged.length === 0"') && scene.includes('kind="filtered"'), 'scene filter misses must be filtered');
  assert(gallery.includes('v-else-if="!visible.length"') && gallery.includes('kind="filtered"'), 'gallery filter misses must be filtered');
  assert(showcase.includes('v-else-if="manifestLoading"') && showcase.includes('kind="loading"'), 'showcase manifest loading must be loading');
  assert(showcase.includes('v-else-if="!filtered.length"') && showcase.includes(":kind=\"entries.length ? 'filtered' : 'empty'\""), 'showcase must distinguish filter misses from an empty catalog');
  assert(character.includes('v-else-if="!characters.length"') && character.includes('kind="empty"'), 'character empty data must have a real empty state');
  assert(home.includes('ArchiveStatePanel') && home.includes('compact') && home.includes('recent-empty-state'), 'home recent works must use the compact shared state');
  assert(!/recent-empty-state[\s\S]*<div class="empty-state-icon"/.test(home), 'home must not retain the bespoke empty-state icon');
});

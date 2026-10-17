// A serving allowlist, not a file executor or general-purpose path resolver. All manifest
// entries are verified even if excluded here. SVG/CSS/HTML/scripts, fonts, arbitrary JSON,
// source data, and package metadata are intentionally not public resource overrides.
function serviceable(rel: any) {
  if (!rel.startsWith('assets/') || rel.split('/').some((part: any) => part.startsWith('.'))
    || /^assets\/(?:character-references|live2d-candidates)(?:\/|$)/i.test(rel)) return false;
  if (/\.(?:png|jpe?g|webp|avif|gif|ico|mp3|ogg|wav|flac|m4a|mp4|webm)$/i.test(rel)) return true;
  return rel.startsWith('assets/live2d/') && (/\.(?:moc3?|mtn)$/i.test(rel)
    || /\.(?:model3?|physics3?|pose3?|motion3|exp3?|cdi3)\.json$/i.test(rel));
}

export = { serviceable };

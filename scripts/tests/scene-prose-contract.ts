'use strict';

// Structural contract, not semantic/visual acceptance. A complete sentence can
// already include an authored action and specific light/weather clause.
const GENERIC_RENDERING = /\b(?:masterpiece|best quality|high quality|very aesthetic|cinematic lighting|volumetric lighting|dynamic lighting|detailed background|depth of field|clean face|highly detailed|beautiful atmosphere)\b/gi;
const CONCRETE_ATMOSPHERE = /\b(?:sunlight|moonlight|sunbeams?|lamplight|spotlights?|dawn|dusk|twilight|sunset|sunrise|rain|mist|misty|snow|breezes?|shadows?|reflections?|embers|lanterns?|starlight|(?:warm|cool|cold|soft|afternoon|morning|evening|workshop|salon|stage|window)\s+(?:\w+\s+){0,2}light|(?:desk|bedside|paper|street)\s+lamps?)\b/i;
function hasAtmosphericSceneProse(value: string) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 100) return false;
  const authored = text.replace(GENERIC_RENDERING, '').replace(/[^a-z0-9\s]/gi, ' ');
  const words = authored.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 15 || new Set(words).size < 12) return false;
  // The existing identity, lighting-token, length and engine guards still apply.
  if ((text.match(/\.(?=\s|$)/g) || []).length >= 2) return true;
  return /[.!?]["'”’)]?$/.test(text) && CONCRETE_ATMOSPHERE.test(text.replace(GENERIC_RENDERING, ''));
}
export = { hasAtmosphericSceneProse };

/** Source-level policy checks for the prefixed utilities used by this app.
 * This is not a CSS compiler: Tailwind still validates and builds candidates.
 * Keeping their policy-relevant declarations visible prevents @apply/classes
 * from bypassing the same literal and compositor gates as handwritten CSS.
 */
export interface TailwindUtility {
  candidate: string;
  index: number;
  line: number;
  declarations: Array<{ property: string; value: string }>;
}

const layout: Record<string, string> = {
  w: 'width', h: 'height', 'min-w': 'min-width', 'min-h': 'min-height',
  'max-w': 'max-width', 'max-h': 'max-height', top: 'top', bottom: 'bottom',
  left: 'left', right: 'right', inset: 'inset', 'inset-x': 'inset-inline', 'inset-y': 'inset-block',
  start: 'inset-inline-start', end: 'inset-inline-end', p: 'padding', m: 'margin',
  pt: 'padding-top', pb: 'padding-bottom', pl: 'padding-left', pr: 'padding-right',
  mt: 'margin-top', mb: 'margin-bottom', ml: 'margin-left', mr: 'margin-right',
  px: 'padding-inline', py: 'padding-block', mx: 'margin-inline', my: 'margin-block',
  'grid-cols': 'grid-template-columns', 'grid-rows': 'grid-template-rows',
  gap: 'gap', 'gap-x': 'column-gap', 'gap-y': 'row-gap', basis: 'flex-basis',
};
const colorPrefixes = /^(bg|text|border(?:-[xytrblse])?|ring|ring-offset|outline|accent|caret|fill|stroke|decoration|from|via|to|shadow|inset-shadow|divide-[xy])$/;
const literalColor = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const colorProperties = /^(?:color|background(?:-color|-image)?|border(?:-[\w-]+)?|(?:box|text)-shadow|(?:outline|text-decoration|caret|accent|fill|stroke)(?:-color)?|--tw-gradient-.+)$/;

function coreUtility(candidate: string) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] === '[' || candidate[i] === '(') depth++;
    else if (candidate[i] === ']' || candidate[i] === ')') depth--;
    else if (candidate[i] === ':' && depth === 0) start = i + 1;
  }
  return candidate.slice(start).replace(/^!|!$/g, '');
}

function decode(value: string) {
  return value.replace(/(?<!\\)_/g, ' ').replace(/\\_/g, '_');
}

export function utilityDeclarations(candidate: string): TailwindUtility['declarations'] {
  const core = coreUtility(candidate);
  const declaration = (property: string, value: string) => [{ property, value }];
  const size = (value: string) => [{ property: 'width', value }, { property: 'height', value }];
  if (core.startsWith('[') && core.endsWith(']')) {
    const match = core.slice(1, -1).match(/^([\w-]+):(.+)$/);
    return match ? declaration(match[1], decode(match[2])) : [];
  }
  const arbitrary = core.match(/^-?([\w-]+)-\[([\s\S]+)\](?:\/[^\s]+)?$/);
  if (arbitrary) {
    const [, prefix, raw] = arbitrary;
    const value = decode(raw).replace(/^(?:color|length|percentage|number):/, '');
    if (prefix === 'text' && (/^(?:length|percentage):/.test(raw) || /^(?:[-.\d]|calc\(|clamp\(|min\(|max\()/i.test(value))) return declaration('font-size', value);
    if (/^rounded(?:-[\w-]+)?$/.test(prefix)) return declaration('border-radius', value);
    if (prefix === 'z') return declaration('z-index', value);
    if (prefix === 'transition') return declaration('transition-property', value);
    if (prefix === 'animate') return declaration('animation', value);
    if (prefix === 'ease') return declaration('transition-timing-function', value);
    if (prefix === 'size') return size(value);
    if (layout[prefix]) return declaration(layout[prefix], value);
    if (colorPrefixes.test(prefix)) {
      const property = prefix === 'text' ? 'color' : prefix === 'bg' ? 'background' : `${prefix}-color`;
      return declaration(property, value);
    }
  }
  if (core === 'transition-all') return declaration('transition-property', 'all');
  if (core === 'transition-none') return declaration('transition-property', 'none');
  if (/^-?z-\d+$/.test(core)) return declaration('z-index', core.replace(/^-?z-/, core.startsWith('-') ? '-' : ''));
  const layoutCore = core.replace(/^-/, '');
  if (layoutCore.startsWith('size-')) return size(layoutCore.slice(5));
  for (const [prefix, property] of Object.entries(layout).sort(([a], [b]) => b.length - a.length)) {
    if (layoutCore.startsWith(`${prefix}-`)) return declaration(property, layoutCore.slice(prefix.length + 1));
  }
  return [];
}

/** Complete candidates include variants/arbitrary selectors; comments are ignored. */
export function tailwindUtilities(source: string): TailwindUtility[] {
  const text = source.replace(/\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g, comment => comment.replace(/[^\n]/g, ' '));
  const result: TailwindUtility[] = [];
  for (const match of text.matchAll(/\btw:/g)) {
    const start = match.index;
    let depth = 0;
    let end = start;
    for (; end < text.length; end++) {
      const char = text[end];
      if (char === '\\') { end++; continue; }
      if (char === '[' || char === '(') depth++;
      else if (char === ']' || char === ')') { if (!depth) break; depth--; }
      else if (!depth && /[\s'"`<>;{},]/.test(char)) break;
    }
    const candidate = text.slice(start, end);
    result.push({ candidate, index: start, line: text.slice(0, start).split('\n').length, declarations: utilityDeclarations(candidate) });
  }
  return result;
}

export function utilityCss(utility: TailwindUtility) {
  return utility.declarations.map(({ property, value }) => `${property}: ${value};`).join(' ');
}

export function expandTailwindApply(css: string) {
  return css.replace(/@apply\s+([^;]+);/g, (_, candidates: string) => tailwindUtilities(candidates).map(utilityCss).join(' '));
}

export function tailwindColorLiterals(source: string) {
  return tailwindUtilities(source).filter(utility => utility.declarations.some(({ property, value }) => {
    if (!colorProperties.test(property) && !property.endsWith('-color')) return false;
    if (literalColor.test(value)) return true;
    // Arbitrary named colors are literals too; CSS keywords and runtime tokens are not.
    return (property === 'color' || property.endsWith('-color') || /^(background|fill|stroke)$/.test(property))
      && /^[a-z]+$/i.test(value) && !/^(transparent|currentcolor|inherit|initial|unset|revert|none)$/i.test(value);
  }));
}

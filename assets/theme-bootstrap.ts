// Runs before the application bundle so the saved theme also applies to the loading frame.
// Both the gateway path and the bundled hash route need the first-paint theme.
const startupRoute = (location.hash.startsWith('#/') ? location.hash.slice(1) : location.pathname)
  .split('?')[0]?.replace(/\/+$/, '')
const startupDesktop = '__TAURI_INTERNALS__' in window || 'companionDesktop' in window
if (startupDesktop && (startupRoute === '/companion' || startupRoute === '/companion.html' || startupRoute === '/companion-chat')) {
  document.documentElement.classList.add('companion-mode', 'companion-desktop');
} else if (startupDesktop) {
  document.documentElement.classList.add('aics-desktop-shell');
}
// Default to inexpensive material before any app CSS or effect installation.
document.documentElement.dataset.glassMaterial = 'light';
document.documentElement.dataset.themeStyle = 'atelier';
let startupThemeMode: unknown;
try {
  const appearance = JSON.parse(localStorage.getItem('atelier-desktop-appearance-v1') || 'null');
  startupThemeMode = appearance?.theme;
  const pixelTheme = appearance?.style === 'terraria';
  document.documentElement.dataset.themeStyle = pixelTheme ? 'terraria' : 'atelier';
  if (!pixelTheme && appearance?.palette === 'yozakura') document.documentElement.dataset.themePalette = 'yozakura';
  const reduced = pixelTheme || appearance?.reducedGlass === true || ['(forced-colors: active)', '(prefers-contrast: more)', '(prefers-reduced-transparency: reduce)']
    .some(query => matchMedia(query).matches);
  document.documentElement.dataset.reducedGlass = String(reduced);
  if (appearance?.glass === 'liquid' && !reduced) document.documentElement.dataset.glassMaterial = 'liquid';
} catch { /* Invalid or unavailable preferences keep the light material. */ }
try {
  const savedTheme = localStorage.getItem('aics_theme');
  const selectedTheme = startupThemeMode ?? savedTheme;
  const initialTheme = selectedTheme === 'dark' || selectedTheme === 'light' ? selectedTheme
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = initialTheme;
  document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.setAttribute('content', initialTheme);
} catch { /* Storage may be unavailable; the document's dark default remains usable. */ }

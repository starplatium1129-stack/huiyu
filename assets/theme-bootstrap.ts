// Runs before the application bundle so the saved theme also applies to the loading frame.
// The native pet must be transparent before Vue mounts, not just after its CSS loads.
if (location.pathname.replace(/\/+$/, '') === '/companion' && 'companionDesktop' in window) {
  document.documentElement.classList.add('companion-mode', 'companion-desktop');
}
// Default to inexpensive material before any app CSS or effect installation.
document.documentElement.dataset.glassMaterial = 'light';
try {
  const appearance = JSON.parse(localStorage.getItem('atelier-desktop-appearance-v1') || 'null');
  const reduced = appearance?.reducedGlass === true || ['(forced-colors: active)', '(prefers-contrast: more)', '(prefers-reduced-transparency: reduce)']
    .some(query => matchMedia(query).matches);
  document.documentElement.dataset.reducedGlass = String(reduced);
  if (appearance?.glass === 'liquid' && !reduced) document.documentElement.dataset.glassMaterial = 'liquid';
} catch { /* Invalid or unavailable preferences keep the light material. */ }
try {
  const savedTheme = localStorage.getItem('aics_theme');
  const initialTheme = savedTheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = initialTheme;
  document.documentElement.style.colorScheme = initialTheme;
} catch { /* Storage may be unavailable; the document's dark default remains usable. */ }

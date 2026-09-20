// Runs before the application bundle so the saved theme also applies to the loading frame.
// The native pet must be transparent before Vue mounts, not just after its CSS loads.
if (location.pathname.replace(/\/+$/, '') === '/companion' && 'companionDesktop' in window) {
  document.documentElement.classList.add('companion-mode', 'companion-desktop');
}
try {
  const savedTheme = localStorage.getItem('aics_theme');
  const initialTheme = savedTheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = initialTheme;
  document.documentElement.style.colorScheme = initialTheme;
} catch { /* Storage may be unavailable; the document's dark default remains usable. */ }

// Runs before the application bundle so the saved theme also applies to the loading frame.
try {
  var savedTheme = localStorage.getItem('aics_theme');
  var initialTheme = savedTheme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = initialTheme;
  document.documentElement.style.colorScheme = initialTheme;
} catch { /* Storage may be unavailable; the document's dark default remains usable. */ }

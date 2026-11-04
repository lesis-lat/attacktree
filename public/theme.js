// Picks the theme before first paint, to avoid a flash. A file rather than an inline
// script, so the Content-Security-Policy can refuse every inline script.
// Same rule as src/ui/theme.ts.
try {
  var p = localStorage.getItem('attacktree:theme');
  var dark = p === 'dark' || (p !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch (e) {}

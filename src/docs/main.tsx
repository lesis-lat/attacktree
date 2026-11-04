// LESIS typography: IBM Plex Sans for text, IBM Plex Mono for labels and code
import '@fontsource-variable/ibm-plex-sans/wght.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '../tokens.css';
import './docs.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DocsApp } from './DocsApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DocsApp />
  </StrictMode>,
);

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

/*
 * The production app is served at the origin root (base "/"), while the static
 * GitHub Pages demo is served under a project subpath (for example
 * "/migraine-tracker/"). React Router must strip the same prefix Vite used for
 * assets, so the basename is derived from BASE_URL at runtime.
 */
const baseUrl = import.meta.env.BASE_URL;
const trimmedBase = baseUrl.replace(/\/$/, '');
const basename = trimmedBase === '' ? undefined : trimmedBase;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

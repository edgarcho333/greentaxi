import React from 'react';
import ReactDOM from 'react-dom/client';
import HtmlPreview from './HtmlPreview';
import { installPreviewApi } from './htmlPreviewApi';
import './global.css';
import './html-preview.css';

installPreviewApi();
document.body.classList.add('html-preview');
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><HtmlPreview /></React.StrictMode>,
);

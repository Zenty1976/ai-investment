import { createRoot } from 'react-dom/client';

import App from './App';

import './index.css';

// Force dark mode — AI Investment is a dark-only application
document.documentElement.classList.add('dark');

createRoot(document.getElementById('root')!).render(<App />);

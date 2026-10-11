import { createRoot } from 'react-dom/client';
import { AccountPage } from './account-page.tsx';
import './style.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Missing platform UI root');
createRoot(root).render(<AccountPage />);

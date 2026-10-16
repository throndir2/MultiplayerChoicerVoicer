import { createRoot } from 'react-dom/client'
import { App } from './App'
import { cleanupAfterClosedTab } from './lib/storage'
import './styles.css'

cleanupAfterClosedTab()

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)

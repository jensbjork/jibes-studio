import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App'
import { platform } from './lib/platform'
import { startUpdateFeed } from './lib/updates'

// For the styles that differ with the system (the title bar's drag region).
document.documentElement.dataset.platform = platform
// Before the first render: the daily update check may answer before the notice mounts.
startUpdateFeed()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

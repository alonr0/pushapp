import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import WorkoutApp from './WorkoutApp.jsx'
import { initOneSignal } from './onesignal'

initOneSignal()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <WorkoutApp />
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import OneSignal from 'react-onesignal'
import './index.css'
import App from './App.jsx'

const oneSignalAppId = import.meta.env.VITE_ONESIGNAL_APP_ID

if (oneSignalAppId && !globalThis.__pushappOneSignalInit) {
  globalThis.__pushappOneSignalInit = true
  OneSignal.init({
    appId: oneSignalAppId,
    allowLocalhostAsSecureOrigin: import.meta.env.DEV,
    serviceWorkerPath: '/OneSignalSDKWorker.js',
  }).catch((err) => {
    console.warn('OneSignal init failed:', err)
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

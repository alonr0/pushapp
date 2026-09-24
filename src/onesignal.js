import OneSignal from 'react-onesignal'

let initPromise = null

function readAppId() {
  const candidates = [
    import.meta.env.VITE_ONESIGNAL_APP_ID,
    import.meta.env.NEXT_PUBLIC_ONESIGNAL_APP_ID,
  ]
  return candidates.find((value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim()),
  )
}

/** Initialize once; safe to call from main.jsx and before tags/prompts. */
export function initOneSignal() {
  if (initPromise) return initPromise

  const appId = readAppId()
  if (!appId) {
    initPromise = Promise.resolve(false)
    return initPromise
  }

  initPromise = OneSignal.init({
    appId,
    allowLocalhostAsSecureOrigin: import.meta.env.DEV,
    serviceWorkerPath: '/OneSignalSDKWorker.js',
  })
    .then(() => true)
    .catch((err) => {
      console.warn('OneSignal init failed:', err)
      return false
    })

  return initPromise
}

/** Associate this device with the active group for push filters. */
export async function syncOneSignalGroupTag(groupId) {
  const ready = await initOneSignal()
  if (!ready) return

  const gid = String(groupId || '').trim().toLowerCase()
  if (!gid) return
  try {
    await OneSignal.User.addTag('groupId', gid)
  } catch (err) {
    console.warn('OneSignal group tag sync failed:', err)
  }
}

/** Slidedown first, then native permission as fallback. */
export async function promptOneSignalNotifications() {
  const ready = await initOneSignal()
  if (!ready) return

  try {
    if (OneSignal.Notifications?.permission === true) return
    await OneSignal.Slidedown.promptPush()
    return
  } catch (err) {
    console.warn('OneSignal slidedown prompt failed:', err)
  }
  try {
    await OneSignal.Notifications.requestPermission()
  } catch (err) {
    console.warn('OneSignal permission request failed:', err)
  }
}

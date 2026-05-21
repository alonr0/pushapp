import OneSignal from 'react-onesignal'

/** Associate this device with the active Firestore group for push filters. */
export async function syncOneSignalGroupTag(groupId) {
  const gid = String(groupId || '').trim()
  if (!gid) return
  try {
    await OneSignal.User.addTag('groupId', gid)
  } catch (err) {
    console.warn('OneSignal group tag sync failed:', err)
  }
}

/** Slidedown first, then native permission as fallback. */
export async function promptOneSignalNotifications() {
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

/**
 * Adjust one user's totalCount by a delta (e.g. undo a mistaken retro-day total bump).
 *
 * Usage:
 *   npm run fix:total -- <group-id> <display-name> <delta>
 *
 * Example (subtract 75):
 *   npm run fix:total -- ketty789 דביר -75
 */
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from '../src/firebase.js'

const [groupId, displayName, deltaStr] = process.argv.slice(2)
if (!groupId || !displayName || deltaStr === undefined) {
  console.error('Usage: npm run fix:total -- <group-id> <display-name> <delta>')
  process.exit(1)
}

const delta = Number.parseInt(deltaStr, 10)
if (!Number.isFinite(delta)) {
  console.error('delta must be an integer (e.g. -75)')
  process.exit(1)
}

import { toUserDocumentId } from '../src/retroHistory.js'

const userDocId = toUserDocumentId(displayName, groupId)
const ref = doc(db, 'users', userDocId)
const snap = await getDoc(ref)
if (!snap.exists()) {
  console.error(`User not found: users/${userDocId}`)
  process.exit(1)
}

const before = Math.max(0, Math.floor(Number(snap.data().totalCount) || 0))
const after = Math.max(0, before + delta)
await updateDoc(ref, { totalCount: after })
console.log(`users/${userDocId}`)
console.log(`  totalCount: ${before} → ${after} (${delta >= 0 ? '+' : ''}${delta})`)

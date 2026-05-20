import { toPng } from 'html-to-image'

function medalForRank(rank) {
  if (rank === 1) return '🥇'
  if (rank === 2) return '🥈'
  if (rank === 3) return '🥉'
  return ''
}

/** Plain-text leaderboard formatted for WhatsApp and other apps. */
export function formatYesterdayShareText({ rankings, groupName, dateLabel }) {
  const lines = ['🏋️ PushApp — Yesterday results', `📅 ${dateLabel}`]
  if (groupName?.trim()) lines.push(`👥 ${groupName.trim()}`, '')

  const top = rankings.filter((r) => r.rank <= 3)
  for (const row of top) {
    lines.push(`${medalForRank(row.rank)} ${row.name} — ${row.score}`)
  }

  const restScored = rankings.filter((r) => r.rank > 3 && r.score > 0)
  for (const row of restScored) {
    lines.push(`#${row.rank} ${row.name} — ${row.score}`)
  }

  const zeroScorers = rankings.filter((r) => r.score === 0 && r.rank > 3)
  if (zeroScorers.length > 0) {
    lines.push('', 'LOSERS:')
    for (const row of zeroScorers) {
      lines.push(`#${row.rank} ${row.name} — 0`)
    }
  }

  return lines.join('\n').trim()
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Share text via native sheet, or open WhatsApp with pre-filled message.
 * @returns {{ method: string }}
 */
export async function shareTextMessage(text) {
  if (navigator.share) {
    try {
      await navigator.share({ text, title: "Yesterday's standings" })
      return { method: 'native' }
    } catch (err) {
      if (err?.name === 'AbortError') return { method: 'cancelled' }
    }
  }

  const copied = await copyToClipboard(text)
  const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`
  window.open(waUrl, '_blank', 'noopener,noreferrer')
  return { method: copied ? 'whatsapp_clipboard' : 'whatsapp' }
}

/**
 * Capture a DOM node as PNG and share or download (WhatsApp accepts shared images on mobile).
 * @returns {{ method: string }}
 */
export async function shareStandingsImage(element, filename = 'yesterday-standings.png') {
  if (!element) throw new Error('Nothing to capture')

  const dataUrl = await toPng(element, {
    cacheBust: true,
    pixelRatio: 2,
    backgroundColor: '#020617',
  })

  const blob = await (await fetch(dataUrl)).blob()
  const file = new File([blob], filename, { type: 'image/png' })

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: "Yesterday's standings",
      })
      return { method: 'native_file' }
    } catch (err) {
      if (err?.name === 'AbortError') return { method: 'cancelled' }
    }
  }

  const link = document.createElement('a')
  link.download = filename
  link.href = dataUrl
  link.click()
  return { method: 'download' }
}

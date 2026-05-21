// netlify/functions/send-push.js

function readEnv(name) {
  return process.env[name] || process.env[`VITE_${name}`] || ''
}

function onesignalAuthHeader(apiKey) {
  const key = String(apiKey || '').trim()
  if (!key) return ''
  if (/^(Key|Basic)\s+/i.test(key)) return key
  return `Key ${key}`
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' }
  }

  try {
    const body = JSON.parse(event.body || '{}')
    const username = String(body.username || '').trim()
    const repsCount = Math.max(0, Math.floor(Number(body.repsCount) || 0))
    const groupName = String(body.groupName || '').trim() || 'your crew'
    const currentGroupId = String(body.currentGroupId || '').trim().toLowerCase()

    if (!username || repsCount <= 0 || !currentGroupId) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'username, repsCount (> 0), and currentGroupId are required',
        }),
      }
    }

    const appId = readEnv('ONESIGNAL_APP_ID')
    const restApiKey = readEnv('ONESIGNAL_REST_API_KEY')
    const authorization = onesignalAuthHeader(restApiKey)

    if (!appId || !authorization) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error:
            'Missing OneSignal credentials. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY (or VITE_* equivalents) for Netlify functions.',
        }),
      }
    }

    const response = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
      },
      body: JSON.stringify({
        app_id: appId,
        target_channel: 'push',
        headings: { en: 'PushApp Alert! 🔥' },
        contents: {
          en: `${username} just logged ${repsCount} pushups in ${groupName}!`,
        },
        filters: [
          { field: 'tag', key: 'groupId', relation: '=', value: currentGroupId },
        ],
      }),
    })

    const data = await response.json().catch(() => ({}))

    if (!response.ok || data.errors) {
      console.error('OneSignal API error:', response.status, data)
      return {
        statusCode: response.ok ? 502 : response.status,
        body: JSON.stringify({
          success: false,
          onesignal: data,
        }),
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, onesignal: data }),
    }
  } catch (error) {
    console.error('send-push failed:', error)
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    }
  }
}

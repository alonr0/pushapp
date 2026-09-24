import { createClient } from '@supabase/supabase-js'

function readEnv(name) {
  return process.env[name] || ''
}

function onesignalAuthHeader(apiKey) {
  const key = String(apiKey || '').trim()
  if (!key) return ''
  if (/^(Key|Basic)\s+/i.test(key)) return key
  return `Key ${key}`
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return response.status(405).send('Method Not Allowed')
  }

  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : request.body || {}
    const username = String(body.username || '').trim()
    const repsCount = Math.max(0, Math.floor(Number(body.repsCount) || 0))
    const groupName = String(body.groupName || '').trim() || 'your crew'
    const currentGroupId = String(body.currentGroupId || '').trim().toLowerCase()
    const accessToken = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1]

    if (!username || !Number.isSafeInteger(repsCount) || repsCount <= 0 || repsCount > 2_147_483_647 || !currentGroupId || !accessToken) {
      return response.status(400).json({
        error: 'A Supabase session, username, repsCount (> 0), and currentGroupId are required',
      })
    }

    const supabaseUrl = readEnv('SUPABASE_URL') || readEnv('VITE_SUPABASE_URL')
    const supabaseKey = readEnv('SUPABASE_PUBLISHABLE_KEY') || readEnv('VITE_SUPABASE_PUBLISHABLE_KEY') || readEnv('VITE_SUPABASE_ANON_KEY')
    if (!supabaseUrl || !supabaseKey) {
      return response.status(500).json({ error: 'Missing Supabase URL or publishable key.' })
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    })
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken)
    if (authError || !user) return response.status(401).json({ error: 'Invalid Supabase session.' })

    const { data: membership, error: membershipError } = await supabase
      .from('group_memberships')
      .select('display_name')
      .eq('user_id', user.id)
      .eq('group_id', currentGroupId)
      .maybeSingle()
    if (membershipError) throw membershipError
    if (!membership || membership.display_name.toLowerCase() !== username.toLowerCase()) {
      return response.status(403).json({ error: 'You are not a member of this group.' })
    }

    const appId = readEnv('ONESIGNAL_APP_ID')
    const authorization = onesignalAuthHeader(readEnv('ONESIGNAL_REST_API_KEY'))
    if (!appId || !authorization) {
      return response.status(500).json({
        error: 'Missing OneSignal credentials. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY in Vercel.',
      })
    }

    const upstream = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
      },
      body: JSON.stringify({
        app_id: appId,
        target_channel: 'push',
        headings: { en: 'PushApp Alert! 🔥' },
        contents: { en: `${membership.display_name} just logged ${repsCount} pushups in ${groupName}!` },
        filters: [{ field: 'tag', key: 'groupId', relation: '=', value: currentGroupId }],
      }),
    })

    const data = await upstream.json().catch(() => ({}))
    if (!upstream.ok || data.errors) {
      console.error('OneSignal API error:', upstream.status, data)
      return response.status(upstream.ok ? 502 : upstream.status).json({ success: false, onesignal: data })
    }

    return response.status(200).json({ success: true, onesignal: data })
  } catch (error) {
    console.error('send-push failed:', error)
    return response.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
}

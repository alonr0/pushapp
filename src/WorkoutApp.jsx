import { useEffect, useMemo, useState } from 'react'
import { promptOneSignalNotifications, syncOneSignalGroupTag } from './onesignal'
import {
  joinWorkoutGroup,
  listWorkoutProfiles,
  logWorkoutReps,
  readWorkoutGroup,
  subscribeToWorkoutGroup,
} from './activeStore'
import { supabase } from './store'
import { translate, exerciseLabel } from './translations'
import {
  currentStreakDays,
  EXERCISES,
  getIsraelDate,
} from './workoutScoring'

const LANGUAGE_KEY = 'pushapp_language'
const THEME_KEY = 'pushapp_theme'
const ACTIVE_GROUP_KEY = 'pushapp_active_group'

function readPreference(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}

function formatPoints(points) {
  const value = Number(points) || 0
  return value.toFixed(1).replace(/\.0$/, '')
}

function PreferenceControls({ language, setLanguage, theme, setTheme, t }) {
  return (
    <div className="preference-controls" aria-label={t('settings')}>
      <button
        type="button"
        className="quiet-button"
        onClick={() => setLanguage(language === 'en' ? 'he' : 'en')}
        aria-label={`${t('language')}: ${language === 'en' ? 'עברית' : 'English'}`}
      >
        {language === 'en' ? 'עב' : 'EN'}
      </button>
      <button
        type="button"
        className="quiet-button theme-button"
        onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        aria-label={theme === 'light' ? t('darkTheme') : t('lightTheme')}
        title={theme === 'light' ? t('darkTheme') : t('lightTheme')}
      >
        <span aria-hidden>{theme === 'light' ? '☾' : '☀'}</span>
        <span className="theme-button-label">{theme === 'light' ? t('darkTheme') : t('lightTheme')}</span>
      </button>
    </div>
  )
}

function Brand({ language, theme, setTheme, setLanguage, t }) {
  return (
    <header className="brand-bar">
      <a className="brand-mark" href="#today" aria-label={t('appName')}>
        <img className="brand-symbol" src="/logo.png" alt="" />
        <span>{t('appName')}</span>
      </a>
      <PreferenceControls
        language={language}
        setLanguage={setLanguage}
        theme={theme}
        setTheme={setTheme}
        t={t}
      />
    </header>
  )
}

function AuthScreen({ language, theme, setLanguage, setTheme, t }) {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [awaitingEmailCode, setAwaitingEmailCode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const runAuth = async (action) => {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      await action()
    } catch (authError) {
      setError(authError?.message || t('authError'))
    } finally {
      setBusy(false)
    }
  }

  const submitEmailPassword = (event) => {
    event.preventDefault()
    if (!password) {
      setError(t('passwordHelp'))
      return
    }
    void runAuth(async () => {
      const result = mode === 'signup'
        ? await supabase.auth.signUp({ email: email.trim(), password })
        : await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (result.error) throw result.error
      if (mode === 'signup' && !result.data.session) setMessage(t('signupSent'))
    })
  }

  const sendEmailLink = () => {
    if (!email.trim()) {
      setError(t('authError'))
      return
    }
    void runAuth(async () => {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: window.location.origin,
          shouldCreateUser: true,
        },
      })
      if (otpError) throw otpError
      setAwaitingEmailCode(true)
      setMessage(t('emailSent'))
    })
  }

  const verifyEmailCode = () => {
    void runAuth(async () => {
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: emailCode.trim(),
        type: 'email',
      })
      if (verifyError) throw verifyError
    })
  }

  const sendPasswordReset = () => {
    if (!email.trim()) {
      setError(t('authError'))
      return
    }
    void runAuth(async () => {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: window.location.origin,
      })
      if (resetError) throw resetError
      setMessage(t('resetSent'))
    })
  }

  const signInWithProvider = (provider) => {
    void runAuth(async () => {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: window.location.origin },
      })
      if (oauthError) throw oauthError
    })
  }

  return (
    <main className="auth-layout">
      <Brand
        language={language}
        theme={theme}
        setLanguage={setLanguage}
        setTheme={setTheme}
        t={t}
      />
      <section className="auth-content" aria-labelledby="auth-title">
        <div className="auth-intro">
          <div className="auth-kicker">{t('tagline')}</div>
          <h1 id="auth-title">{mode === 'signin' ? t('welcome') : t('createAccount')}</h1>
          <p>{t('accountRequired')}</p>
        </div>
        <div className="auth-form-wrap">
          {error && <p className="notice notice-error" role="alert">{error}</p>}
          {message && <p className="notice notice-success" role="status">{message}</p>}
          <form className="auth-form" onSubmit={submitEmailPassword}>
            <label>
              <span>{t('email')}</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                disabled={busy}
              />
            </label>
            <label>
              <span>{t('password')}</span>
              <input
                type="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                minLength={8}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t('passwordHelp')}
                disabled={busy}
              />
            </label>
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? t('loading') : t('emailPassword')}
            </button>
            <button type="button" className="text-button" onClick={sendEmailLink} disabled={busy}>
              {t('sendLink')}
            </button>
            {awaitingEmailCode && (
              <div className="otp-entry">
                <label>
                  <span>{t('emailCode')}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={8}
                    value={emailCode}
                    onChange={(event) => setEmailCode(event.target.value.replace(/\s/g, ''))}
                    disabled={busy}
                  />
                </label>
                <button type="button" className="primary-button" onClick={verifyEmailCode} disabled={busy || !emailCode.trim()}>
                  {busy ? t('loading') : t('verifyCode')}
                </button>
              </div>
            )}
          </form>
          <div className="auth-divider"><span>{language === 'he' ? 'או' : 'or'}</span></div>
          <div className="provider-buttons">
            <button type="button" className="provider-button" onClick={() => signInWithProvider('google')} disabled={busy}>
              <span className="provider-g" aria-hidden>G</span>{t('google')}
            </button>
            <button type="button" className="provider-button" onClick={() => signInWithProvider('apple')} disabled={busy}>
              <span className="provider-apple" aria-hidden>●</span>{t('apple')}
            </button>
          </div>
          <button
            type="button"
            className="text-button mode-switch"
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin')
              setError('')
              setMessage('')
            }}
          >
            {mode === 'signin' ? t('switchToSignUp') : t('switchToSignIn')}
          </button>
          {mode === 'signin' && (
            <button type="button" className="text-button" onClick={sendPasswordReset} disabled={busy}>
              {t('forgotPassword')}
            </button>
          )}
        </div>
      </section>
    </main>
  )
}

function PasswordRecoveryScreen({ language, theme, setLanguage, setTheme, onComplete, t }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [updated, setUpdated] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    if (password !== confirmation) {
      setError(t('passwordMismatch'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) throw updateError
      setUpdated(true)
    } catch (updateError) {
      setError(updateError.message || t('authError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-layout">
      <Brand language={language} theme={theme} setLanguage={setLanguage} setTheme={setTheme} t={t} />
      <section className="auth-content">
        <div className="auth-intro"><h1>{t('changePassword')}</h1></div>
        {updated ? (
          <div className="auth-form">
            <p className="notice notice-success">{t('passwordUpdated')}</p>
            <button type="button" className="primary-button" onClick={onComplete}>{t('signIn')}</button>
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <label>
              <span>{t('newPassword')}</span>
              <input type="password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <label>
              <span>{t('confirmPassword')}</span>
              <input type="password" minLength={8} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
            </label>
            {error && <p className="notice notice-error" role="alert">{error}</p>}
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? t('loading') : t('changePassword')}
            </button>
          </form>
        )}
      </section>
    </main>
  )
}

function GroupJoinScreen({ session, profiles, onJoined, onSignOut, t }) {
  const [displayName, setDisplayName] = useState(session.user.user_metadata?.full_name || '')
  const [groupCode, setGroupCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await joinWorkoutGroup(groupCode, displayName)
      await onJoined(groupCode.trim().toLowerCase())
    } catch (joinError) {
      setError(joinError?.message || t('groupError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-content join-content">
        <div className="auth-intro">
          <div className="auth-kicker">{t('welcome')}</div>
          <h1>{t('joinCrew')}</h1>
          <p>{t('joinPrompt')}</p>
        </div>
        {profiles.length > 0 && (
          <div className="profile-list">
            {profiles.map((profile) => (
              <button key={profile.group_id} type="button" className="profile-choice" onClick={() => void onJoined(profile.group_id)}>
                <span>{profile.display_name}</span>
                <small>{profile.group_id}</small>
              </button>
            ))}
          </div>
        )}
        <form className="auth-form" onSubmit={submit}>
          <label>
            <span>{t('displayName')}</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={40} />
          </label>
          <label>
            <span>{t('groupCode')}</span>
            <input value={groupCode} onChange={(event) => setGroupCode(event.target.value)} required maxLength={60} autoCapitalize="none" />
          </label>
          {error && <p className="notice notice-error" role="alert">{error}</p>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? t('loading') : t('joinCrew')}
          </button>
          <button className="text-button" type="button" onClick={onSignOut}>{t('signOut')}</button>
        </form>
      </section>
    </main>
  )
}

function ExerciseRow({ exercise, reps, busy, onLog, t, language }) {
  const [amount, setAmount] = useState('5')
  const [error, setError] = useState('')
  const remaining = exercise.limit - reps
  const percentage = Math.round((reps / exercise.limit) * 100)
  const categoryPoints = Math.round((25 * reps / exercise.limit) * 10) / 10

  const submit = async (event) => {
    event.preventDefault()
    const value = Number(amount)
    if (!Number.isInteger(value) || value < 1 || value > remaining) {
      setError(t('invalidReps'))
      return
    }
    setError('')
    try {
      await onLog(exercise.id, value)
      setAmount(String(Math.min(5, exercise.limit - reps - value) || 1))
    } catch (logError) {
      setError(logError?.message?.includes('exceed') ? t('invalidReps') : t('saveError'))
    }
  }

  return (
    <article className={`exercise-row ${remaining === 0 ? 'exercise-complete' : ''}`}>
      <div className="exercise-heading">
        <div>
          <h3>{exerciseLabel(language, exercise.id)}</h3>
          <p className="exercise-count">{reps} <span>/ {exercise.limit} {t('reps')}</span></p>
        </div>
        <div className="exercise-points">
          <strong>{formatPoints(categoryPoints)}</strong>
          <span>/ 25 {t('points')}</span>
        </div>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={exerciseLabel(language, exercise.id)}
        aria-valuenow={reps}
        aria-valuemin={0}
        aria-valuemax={exercise.limit}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
      <div className="exercise-footer">
        {remaining > 0 ? (
          <>
            <span className="remaining-count">{remaining} {t('left')}</span>
            <form className="rep-form" onSubmit={submit}>
              <input
                aria-label={`${t('add')} ${exerciseLabel(language, exercise.id)}`}
                type="number"
                inputMode="numeric"
                min="1"
                max={remaining}
                step="1"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                disabled={busy}
              />
              <button
                className="small-primary"
                type="submit"
                aria-label={`${t('add')} ${exerciseLabel(language, exercise.id)}`}
                disabled={busy}
              >
                {busy ? '…' : '+'}
                <span>{t('add')}</span>
              </button>
            </form>
          </>
        ) : (
          <span className="complete-label">{t('maxed')} <b>+2</b></span>
        )}
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </article>
  )
}

function AppNav({ tab, setTab, t }) {
  const items = [
    ['workout', 'workout'],
    ['standings', 'standings'],
    ['history', 'history'],
  ]
  return (
    <nav className="app-nav" aria-label={t('appName')}>
      {items.map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={tab === id ? 'nav-item active' : 'nav-item'}
          aria-current={tab === id ? 'page' : undefined}
          onClick={() => setTab(id)}
        >
          {t(label)}
        </button>
      ))}
    </nav>
  )
}

export default function WorkoutApp() {
  const [language, setLanguage] = useState(() => readPreference(LANGUAGE_KEY, 'en'))
  const [theme, setTheme] = useState(() => readPreference(THEME_KEY, 'light'))
  const [session, setSession] = useState(null)
  const [passwordRecovery, setPasswordRecovery] = useState(false)
  const [authReady, setAuthReady] = useState(false)
  const [profileState, setProfileState] = useState({ userId: '', profiles: [] })
  const [activeGroupId, setActiveGroupId] = useState(() => readPreference(ACTIVE_GROUP_KEY, ''))
  const [groupData, setGroupData] = useState({ groupId: '', profiles: [], scores: [], rewards: [] })
  const [loadedGroupId, setLoadedGroupId] = useState('')
  const [dataError, setDataError] = useState('')
  const [tab, setTab] = useState('workout')
  const [busyExercise, setBusyExercise] = useState('')
  const [israelToday, setIsraelToday] = useState(() => getIsraelDate())

  const t = (key) => translate(language, key)
  const profiles = profileState.userId === session?.user?.id ? profileState.profiles : []
  const profileLoading = Boolean(session?.user?.id && profileState.userId !== session.user.id)
  const profile = profiles.find((item) => item.group_id === activeGroupId) || profiles[0] || null
  const dataLoading = Boolean(profile?.group_id && loadedGroupId !== profile.group_id)
  const activeGroupData = groupData.groupId === profile?.group_id
    ? groupData
    : { profiles: [], scores: [], rewards: [] }

  useEffect(() => {
    try {
      localStorage.setItem(LANGUAGE_KEY, language)
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // Preferences still work for the current page when storage is unavailable.
    }
    document.documentElement.lang = language
    document.documentElement.dir = language === 'he' ? 'rtl' : 'ltr'
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'dark' ? '#1c251e' : '#f2f5ef',
    )
  }, [language, theme])

  useEffect(() => {
    let alive = true
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (alive) setSession(nextSession?.user?.is_anonymous ? null : nextSession)
      if (alive && event === 'PASSWORD_RECOVERY') setPasswordRecovery(true)
    })
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!alive) return
      if (error) setDataError(error.message)
      const currentSession = data.session
      if (currentSession?.user?.is_anonymous) {
        void supabase.auth.signOut().finally(() => {
          if (alive) {
            setSession(null)
            setAuthReady(true)
          }
        })
      } else {
        setSession(currentSession)
        setAuthReady(true)
      }
    })
    return () => {
      alive = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    const updateDate = () => setIsraelToday(getIsraelDate())
    const timer = window.setInterval(updateDate, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const userId = session?.user?.id
    if (!userId) return undefined
    let alive = true
    void listWorkoutProfiles(userId).then((nextProfiles) => {
      if (!alive) return
      setProfileState({ userId, profiles: nextProfiles })
      setActiveGroupId((current) =>
        nextProfiles.some((item) => item.group_id === current)
          ? current
          : nextProfiles[0]?.group_id || '',
      )
    }).catch((error) => {
      if (alive) {
        setProfileState({ userId, profiles: [] })
        setDataError(error.message || translate(language, 'setupError'))
      }
    })
    return () => { alive = false }
  }, [session?.user?.id, language])

  const selectGroup = (groupId) => {
    const nextProfile = profiles.find((item) => item.group_id === groupId)
    if (!nextProfile) return
    setActiveGroupId(groupId)
    setTab('workout')
    try {
      localStorage.setItem(ACTIVE_GROUP_KEY, groupId)
    } catch {
      // The selected crew remains active for this session.
    }
  }

  const refreshGroup = async (groupId = profile?.group_id) => {
    if (!groupId) return
    const nextData = await readWorkoutGroup(groupId)
    setGroupData({ ...nextData, groupId })
    setDataError('')
  }

  const handleJoined = async (groupId) => {
    const nextProfiles = await listWorkoutProfiles(session.user.id)
    setProfileState({ userId: session.user.id, profiles: nextProfiles })
    const nextProfile = nextProfiles.find((item) => item.group_id === groupId)
    if (!nextProfile) throw new Error(t('setupError'))
    setActiveGroupId(groupId)
    try {
      localStorage.setItem(ACTIVE_GROUP_KEY, groupId)
    } catch {
      // Continue without persisting the selected group.
    }
    await syncOneSignalGroupTag(groupId)
    void promptOneSignalNotifications()
  }

  useEffect(() => {
    if (!profile?.group_id) return undefined
    let alive = true
    void readWorkoutGroup(profile.group_id).then((nextData) => {
      if (alive) {
        setGroupData({ ...nextData, groupId: profile.group_id })
        setDataError('')
      }
    }).catch((error) => {
      if (alive) setDataError(error.message || translate(language, 'setupError'))
    }).finally(() => {
      if (alive) setLoadedGroupId(profile.group_id)
    })
    const unsubscribe = subscribeToWorkoutGroup(
      profile.group_id,
      () => void readWorkoutGroup(profile.group_id).then((nextData) => {
        if (alive) setGroupData({ ...nextData, groupId: profile.group_id })
      }).catch((error) => setDataError(error.message)),
      (error) => setDataError(error.message || translate(language, 'setupError')),
    )
    return () => {
      alive = false
      unsubscribe()
    }
  }, [profile?.group_id, language])

  useEffect(() => {
    if (profile?.group_id) void syncOneSignalGroupTag(profile.group_id)
  }, [profile?.group_id])

  const todayRows = useMemo(
    () => activeGroupData.scores.filter((row) => row.activity_date === israelToday),
    [activeGroupData.scores, israelToday],
  )
  const myToday = todayRows.find((row) => row.user_id === profile?.user_id) ?? null
  const myReps = {
    pushups: myToday?.pushups_reps ?? 0,
    pullups: myToday?.pullups_reps ?? 0,
    crunches: myToday?.crunches_reps ?? 0,
    squats: myToday?.squats_reps ?? 0,
  }
  const myBasePoints = Number(myToday?.base_points) || 0
  const myDailyPoints = Number(myToday?.daily_points) || 0
  const myStreak = currentStreakDays(activeGroupData.scores, profile?.user_id, israelToday)
  const myStreakPoints = activeGroupData.rewards
    .filter((reward) => reward.user_id === profile?.user_id)
    .reduce((total, reward) => total + Number(reward.bonus_points || 0), 0)
  const myLifetimePoints = activeGroupData.scores
    .filter((row) => row.user_id === profile?.user_id)
    .reduce((total, row) => total + Number(row.daily_points || 0), 0)
  const myQualifiedDays = activeGroupData.scores
    .filter((row) => row.user_id === profile?.user_id && row.qualifies_for_streak)
    .length
  const standings = activeGroupData.profiles.map((member) => {
    const score = todayRows.find((row) => row.user_id === member.user_id)
    return {
      ...member,
      dailyPoints: Number(score?.daily_points) || 0,
      basePoints: Number(score?.base_points) || 0,
      completed: Number(score?.completed_categories) || 0,
      isYou: member.user_id === profile?.user_id,
    }
  }).sort((a, b) => b.dailyPoints - a.dailyPoints || a.display_name.localeCompare(b.display_name))
  const allTimeStandings = activeGroupData.profiles.map((member) => {
    const exercisePoints = activeGroupData.scores
      .filter((row) => row.user_id === member.user_id)
      .reduce((total, row) => total + Number(row.daily_points || 0), 0)
    const streakPoints = activeGroupData.rewards
      .filter((reward) => reward.user_id === member.user_id)
      .reduce((total, reward) => total + Number(reward.bonus_points || 0), 0)
    return {
      ...member,
      totalPoints: exercisePoints + streakPoints,
      isYou: member.user_id === profile?.user_id,
    }
  }).sort((a, b) => b.totalPoints - a.totalPoints || a.display_name.localeCompare(b.display_name))

  const handleLog = async (exerciseId, reps) => {
    setBusyExercise(exerciseId)
    try {
      await logWorkoutReps(profile.group_id, exerciseId, reps)
      await refreshGroup(profile.group_id)
      try {
        const { data: { session: currentSession }, error: sessionError } = await supabase.auth.getSession()
        if (sessionError) throw sessionError
        if (currentSession?.access_token) {
          const response = await fetch('/api/send-push', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${currentSession.access_token}`,
            },
            body: JSON.stringify({
              username: profile.display_name,
              repsCount: reps,
              exerciseId,
              language,
              groupName: profile.group_id,
              currentGroupId: profile.group_id,
            }),
          })
          if (!response.ok) console.warn('Push notification request failed:', response.status)
        }
      } catch (pushError) {
        console.warn('Push notification request failed:', pushError)
      }
    } finally {
      setBusyExercise('')
    }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  if (!authReady || profileLoading) {
    return <main className="loading-screen" role="status">{t('loading')}</main>
  }

  if (!session) {
    return (
      <AuthScreen
        language={language}
        theme={theme}
        setLanguage={setLanguage}
        setTheme={setTheme}
        t={t}
      />
    )
  }

  if (passwordRecovery) {
    return (
      <PasswordRecoveryScreen
        language={language}
        theme={theme}
        setLanguage={setLanguage}
        setTheme={setTheme}
        onComplete={() => setPasswordRecovery(false)}
        t={t}
      />
    )
  }

  if (!profile) {
    return (
      <>
        <Brand language={language} theme={theme} setLanguage={setLanguage} setTheme={setTheme} t={t} />
        <GroupJoinScreen
          session={session}
          profiles={profiles}
          onJoined={handleJoined}
          onSignOut={signOut}
          t={t}
        />
      </>
    )
  }

  return (
    <div className="app-shell">
      <Brand language={language} theme={theme} setLanguage={setLanguage} setTheme={setTheme} t={t} />
      <header className="page-heading">
        <div>
          <p className="eyebrow">{profile.group_id}</p>
          <h1>{tab === 'workout' ? t('today') : tab === 'standings' ? t('standings') : t('history')}</h1>
          <p className="welcome-line">{profile.display_name}</p>
        </div>
        <button type="button" className="quiet-button signout-button" onClick={signOut}>{t('signOut')}</button>
      </header>

      {profiles.length > 1 && (
        <label className="group-switcher">
          <span>{t('groupCode')}</span>
          <select value={profile.group_id} onChange={(event) => selectGroup(event.target.value)}>
            {profiles.map((item) => <option key={item.group_id} value={item.group_id}>{item.group_id}</option>)}
          </select>
        </label>
      )}

      {dataError && <p className="notice notice-error page-notice" role="alert">{dataError}</p>}

      <main className="main-content">
        {tab === 'workout' && (
          <>
            <section className="daily-summary" aria-label={t('today')}>
              <div className="summary-main">
                <span className="summary-label">{t('points')} · {israelToday}</span>
                <strong>{formatPoints(myDailyPoints)}</strong>
                <span className="summary-max">{t('dailyMax')}</span>
              </div>
              <div className="summary-side">
                <span className="streak-flame" aria-hidden>✳</span>
                <strong>{myStreak}</strong>
                <span>{t('streak')}</span>
              </div>
            </section>
            <div className="bonus-line">
              <span>{t('basePoints')} <b>{formatPoints(myBasePoints)}</b></span>
              <span>{t('dailyBonus')} <b>+{Number(myToday?.daily_bonus_points) || 0}</b></span>
            </div>
            <p className="streak-hint">{t('streakProgress')}</p>
            <section className="exercise-list" aria-label={t('workout')}>
              {EXERCISES.map((exercise) => (
                <ExerciseRow
                  key={exercise.id}
                  exercise={exercise}
                  reps={myReps[exercise.id]}
                  busy={busyExercise === exercise.id}
                  onLog={handleLog}
                  t={t}
                  language={language}
                />
              ))}
            </section>
            {EXERCISES.every(({ id, limit }) => myReps[id] === limit) && (
              <p className="all-complete" role="status">✦ {t('allFour')} · +10</p>
            )}
            {dataLoading && <p className="subtle-status">{t('loading')}</p>}
          </>
        )}

        {tab === 'standings' && (
          <section className="content-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">{israelToday}</p>
                <h2>{t('ranking')}</h2>
              </div>
              <span className="live-dot" aria-label="Live" />
            </div>
            {standings.length === 0 ? (
              <p className="empty-state">{t('noScores')}</p>
            ) : (
              <ol className="standings-list">
                {standings.map((member, index) => (
                  <li key={member.user_id} className={member.isYou ? 'standing-row is-you' : 'standing-row'}>
                    <span className="rank-number">{index + 1}</span>
                    <span className="standing-name">{member.display_name}{member.isYou ? <small> · {language === 'he' ? 'את/ה' : 'you'}</small> : null}</span>
                    <span className="standing-detail">{member.completed}/4</span>
                    <strong>{formatPoints(member.dailyPoints)}</strong>
                  </li>
                ))}
              </ol>
            )}
            <div className="section-heading all-time-heading">
              <div><p className="eyebrow">{t('history')}</p><h2>{t('allTimeRanking')}</h2></div>
            </div>
            <ol className="standings-list">
              {allTimeStandings.map((member, index) => (
                <li key={`all-${member.user_id}`} className={member.isYou ? 'standing-row is-you' : 'standing-row'}>
                  <span className="rank-number">{index + 1}</span>
                  <span className="standing-name">{member.display_name}{member.isYou ? <small> · {language === 'he' ? 'את/ה' : 'you'}</small> : null}</span>
                  <span className="standing-detail" />
                  <strong>{formatPoints(member.totalPoints)}</strong>
                </li>
              ))}
            </ol>
          </section>
        )}

        {tab === 'history' && (
          <>
            <section className="stat-grid">
              <article className="stat-cell"><span>{t('lifetime')}</span><strong>{formatPoints(myLifetimePoints)}</strong></article>
              <article className="stat-cell"><span>{t('streakPoints')}</span><strong>{myStreakPoints}</strong></article>
              <article className="stat-cell"><span>{t('streak')}</span><strong>{myStreak}</strong></article>
              <article className="stat-cell"><span>{t('daysQualified')}</span><strong>{myQualifiedDays}</strong></article>
            </section>
            <section className="content-section history-section">
              <div className="section-heading">
                <div><p className="eyebrow">{t('history')}</p><h2>{t('lifetime')}</h2></div>
              </div>
              {activeGroupData.scores.filter((row) => row.user_id === profile.user_id).length === 0 ? (
                <p className="empty-state">{t('noHistory')}</p>
              ) : (
                <ol className="history-list">
                  {activeGroupData.scores.filter((row) => row.user_id === profile.user_id).slice(0, 30).map((row) => (
                    <li key={row.activity_date}>
                      <time dateTime={row.activity_date}>{row.activity_date}</time>
                      <span>{formatPoints(row.base_points)} {t('points')}</span>
                      <strong>{formatPoints(row.daily_points)}</strong>
                    </li>
                  ))}
                </ol>
              )}
              <p className="streak-hint">{t('nextStreak')}: {7 - (myStreak % 7 || 0)} · +5 {t('points')}</p>
            </section>
          </>
        )}
      </main>

      <AppNav tab={tab} setTab={setTab} t={t} />
    </div>
  )
}
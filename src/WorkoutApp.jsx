import { useEffect, useMemo, useRef, useState } from 'react'
import { promptOneSignalNotifications, syncOneSignalGroupTag } from './onesignal'
import {
  joinWorkoutGroup,
  leaveWorkoutGroup,
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
const WELCOME_KEY_PREFIX = 'pushapp_welcome_seen:'

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
        <svg className="theme-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {theme === 'light' ? (
            <path d="M20.2 15.4A8.3 8.3 0 0 1 8.6 3.8 8.5 8.5 0 1 0 20.2 15.4Z" />
          ) : (
            <>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
            </>
          )}
        </svg>
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

function GroupJoinScreen({ session, profiles, onJoined, onLeave, onCancel, onSignOut, t }) {
  const [displayName, setDisplayName] = useState(session.user.user_metadata?.full_name || '')
  const [groupCode, setGroupCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [leavingGroupId, setLeavingGroupId] = useState('')
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

  const handleLeave = async (groupId) => {
    if (!window.confirm(t('leaveCrewConfirm'))) return
    setLeavingGroupId(groupId)
    setError('')
    try {
      await onLeave(groupId)
    } catch (leaveError) {
      setError(leaveError?.message || t('leaveCrewError'))
    } finally {
      setLeavingGroupId('')
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-content join-content">
        <div className="auth-intro">
          <div className="auth-kicker">{t('welcome')}</div>
          <h1>{profiles.length ? t('manageCrews') : t('joinCrew')}</h1>
          <p>{profiles.length ? t('manageCrewsPrompt') : t('joinPrompt')}</p>
        </div>
        {profiles.length > 0 && (
          <div className="profile-list">
            {profiles.map((crewProfile) => (
              <div key={crewProfile.group_id} className="profile-choice-row">
                <button
                  type="button"
                  className="profile-choice"
                  onClick={() => void onJoined(crewProfile.group_id)}
                  disabled={busy || Boolean(leavingGroupId)}
                >
                  <span>{crewProfile.display_name}</span>
                  <small>{crewProfile.group_id}</small>
                </button>
                <button
                  type="button"
                  className="text-button leave-group-button"
                  onClick={() => void handleLeave(crewProfile.group_id)}
                  disabled={busy || Boolean(leavingGroupId)}
                >
                  {leavingGroupId === crewProfile.group_id ? t('loading') : t('leaveCrew')}
                </button>
              </div>
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
          {onCancel && <button className="text-button" type="button" onClick={onCancel}>{t('cancel')}</button>}
          <button className="text-button" type="button" onClick={onSignOut}>{t('signOut')}</button>
        </form>
      </section>
    </main>
  )
}

function ExerciseRow({ exercise, reps, busy, onLog, t, language }) {
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')
  const dialogRef = useRef(null)
  const inputRef = useRef(null)
  const remaining = exercise.limit - reps
  const percentage = Math.round((reps / exercise.limit) * 100)
  const categoryPoints = Math.round((25 * reps / exercise.limit) * 10) / 10

  const openDialog = () => {
    setAmount('')
    setError('')
    dialogRef.current?.showModal()
    requestAnimationFrame(() => inputRef.current?.focus())
  }

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
      dialogRef.current?.close()
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
            <button
              className="add-reps-button"
              type="button"
              aria-label={`${t('add')} ${exerciseLabel(language, exercise.id)}`}
              title={`${t('add')} ${exerciseLabel(language, exercise.id)}`}
              onClick={openDialog}
              disabled={busy}
            >
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <dialog
              ref={dialogRef}
              className="rep-dialog"
              aria-labelledby={`rep-dialog-title-${exercise.id}`}
              onClose={() => setError('')}
            >
              <form className="rep-dialog-form" onSubmit={submit}>
                <h2 id={`rep-dialog-title-${exercise.id}`}>{exerciseLabel(language, exercise.id)}</h2>
                <p className="rep-dialog-copy">{remaining} {t('left')}</p>
                <label htmlFor={`rep-input-${exercise.id}`}>{t('repsToLog')}</label>
                <input
                  ref={inputRef}
                  id={`rep-input-${exercise.id}`}
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max={remaining}
                  step="1"
                  required
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value)
                    setError('')
                  }}
                  onInvalid={(event) => {
                    event.preventDefault()
                    setError(t('invalidReps'))
                  }}
                  disabled={busy}
                />
                {error && <p className="inline-error" role="alert">{error}</p>}
                <div className="rep-dialog-actions">
                  <button
                    className="quiet-button"
                    type="button"
                    onClick={() => dialogRef.current?.close()}
                    disabled={busy}
                  >
                    {t('cancel')}
                  </button>
                  <button className="primary-button" type="submit" disabled={busy || !amount}>
                    {busy ? t('loading') : t('add')}
                  </button>
                </div>
              </form>
            </dialog>
          </>
        ) : (
          <span className="complete-label">{t('maxed')} <b>+2</b></span>
        )}
      </div>
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

function RulesDialog({ mode, onClose, t, language }) {
  const dialogRef = useRef(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (mode && dialog && !dialog.open) dialog.showModal()
    if (!mode && dialog?.open) dialog.close()
  }, [mode])

  if (!mode) return null

  return (
    <dialog className="rules-dialog" ref={dialogRef} onClose={onClose} aria-labelledby="rules-title">
      <div className="rules-dialog-content">
        <header className="rules-dialog-header">
          <div>
            <p className="eyebrow">{mode === 'welcome' ? t('newFeatures') : t('rules')}</p>
            <h2 id="rules-title">{mode === 'welcome' ? t('welcomeTitle') : t('rulesTitle')}</h2>
          </div>
        </header>
        {mode === 'welcome' && <p className="rules-intro">{t('welcomeMessage')}</p>}
        <section className="rules-section">
          <h3>{t('featuresHeading')}</h3>
          <ul>
            <li>{t('featureScoring')}</li>
            <li>{t('featureStreak')}</li>
            <li>{t('featureCrew')}</li>
          </ul>
        </section>
        <section className="rules-section">
          <h3>{t('rulesHeading')}</h3>
          <ul>
            <li>{t('rulesCaps', { exercises: EXERCISES.map(({ id, limit }) => `${exerciseLabel(language, id)} ${limit}`).join(', ') })}</li>
            <li>{t('rulesStreak')}</li>
            <li>{t('rulesScoring')}</li>
            <li>{t('rulesBonuses')}</li>
          </ul>
        </section>
        <div className="rep-dialog-actions">
          <button className="primary-button" type="button" onClick={() => dialogRef.current?.close()}>
            {mode === 'welcome' ? t('startNow') : t('close')}
          </button>
        </div>
      </div>
    </dialog>
  )
}

export default function WorkoutApp() {
  const [language, setLanguage] = useState(() => readPreference(LANGUAGE_KEY, 'he'))
  const [theme, setTheme] = useState(() => readPreference(THEME_KEY, 'light'))
  const [session, setSession] = useState(null)
  const [passwordRecovery, setPasswordRecovery] = useState(false)
  const [authReady, setAuthReady] = useState(false)
  const [profileState, setProfileState] = useState({ userId: '', profiles: [] })
  const [groupJoinOpen, setGroupJoinOpen] = useState(false)
  const [activeGroupId, setActiveGroupId] = useState(() => readPreference(ACTIVE_GROUP_KEY, ''))
  const [groupData, setGroupData] = useState({ groupId: '', profiles: [], scores: [], rewards: [] })
  const [loadedGroupId, setLoadedGroupId] = useState('')
  const [dataError, setDataError] = useState('')
  const [tab, setTab] = useState('workout')
  const [rulesDialog, setRulesDialog] = useState(null)
  const [busyExercise, setBusyExercise] = useState('')
  const [israelToday, setIsraelToday] = useState(() => getIsraelDate())

  const t = (key, params) => translate(language, key, params)
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
    const isFirstCrew = profiles.length === 0
    const nextProfiles = await listWorkoutProfiles(session.user.id)
    setProfileState({ userId: session.user.id, profiles: nextProfiles })
    setGroupJoinOpen(false)
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
    if (
      isFirstCrew &&
      readPreference(`${WELCOME_KEY_PREFIX}${session.user.id}`, '') !== '1'
    ) setRulesDialog('welcome')
  }

  const closeRulesDialog = () => {
    if (rulesDialog === 'welcome' && session?.user?.id) {
      try {
        localStorage.setItem(`${WELCOME_KEY_PREFIX}${session.user.id}`, '1')
      } catch {
        // The welcome can still be dismissed for this session.
      }
    }
    setRulesDialog(null)
  }

  const handleLeaveGroup = async (groupId) => {
    await leaveWorkoutGroup(groupId)
    const nextProfiles = await listWorkoutProfiles(session.user.id)
    setProfileState({ userId: session.user.id, profiles: nextProfiles })

    if (profile?.group_id !== groupId) return

    const nextGroupId = nextProfiles[0]?.group_id || ''
    setActiveGroupId(nextGroupId)
    setLoadedGroupId('')
    setGroupData({ groupId: '', profiles: [], scores: [], rewards: [] })
    setDataError('')
    try {
      if (nextGroupId) localStorage.setItem(ACTIVE_GROUP_KEY, nextGroupId)
      else localStorage.removeItem(ACTIVE_GROUP_KEY)
    } catch {
      // Crew state still updates for this session if storage is unavailable.
    }
    await syncOneSignalGroupTag(nextGroupId)
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
              groupName: profile.group_id,
              currentGroupId: profile.group_id,
            }),
          })
          if (!response.ok) console.warn('Push notification request failed:', response.status)
        }
      } catch (pushError) {
        console.warn('Push notification request failed:', pushError)
      }
      await refreshGroup(profile.group_id)
    } finally {
      setBusyExercise('')
    }
  }

  const signOut = async () => {
    setGroupJoinOpen(false)
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

  if (!profile || groupJoinOpen) {
    return (
      <>
        <Brand language={language} theme={theme} setLanguage={setLanguage} setTheme={setTheme} t={t} />
        <GroupJoinScreen
          session={session}
          profiles={profiles}
          onJoined={handleJoined}
          onLeave={handleLeaveGroup}
          onCancel={profile ? () => setGroupJoinOpen(false) : undefined}
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
        <div className="page-heading-actions">
          <button type="button" className="quiet-button" onClick={() => setRulesDialog('rules')}>{t('rules')}</button>
          <button type="button" className="quiet-button signout-button" onClick={signOut}>{t('signOut')}</button>
        </div>
      </header>

      <div className="crew-toolbar">
        {profiles.length > 1 && (
          <label className="group-switcher">
            <span>{t('groupCode')}</span>
            <select value={profile.group_id} onChange={(event) => selectGroup(event.target.value)}>
              {profiles.map((item) => <option key={item.group_id} value={item.group_id}>{item.group_id}</option>)}
            </select>
          </label>
        )}
        <button type="button" className="quiet-button" onClick={() => setGroupJoinOpen(true)}>
          {t('manageCrews')}
        </button>
      </div>

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
                <svg className="streak-flame" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 22c4.1 0 7-2.8 7-6.7 0-3.3-2-5.7-4.1-7.8.1 2.3-.8 3.8-2 4.7C13 8.3 10.5 5 8.5 2.5c.3 3.8-.3 5.7-2.2 8A7.4 7.4 0 0 0 5 15.3C5 19.2 7.8 22 12 22Z" />
                  <path d="M12 19a3 3 0 0 0 3-3c0-1.4-.9-2.5-2.1-3.7-.2 1.1-.7 1.8-1.6 2.4-.5-.7-1-1.1-1.7-1.5-.3.7-.6 1.4-.6 2.4a3.1 3.1 0 0 0 3 3.4Z" />
                </svg>
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
      <RulesDialog mode={rulesDialog} onClose={closeRulesDialog} t={t} language={language} />
    </div>
  )
}
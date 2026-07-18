import { useState, useEffect, useCallback, useRef, ReactNode } from 'react'
import { Box, Typography, TextField, Button, Alert, Tooltip, IconButton, Skeleton } from '@mui/material'
import TelegramIcon from '@mui/icons-material/Telegram'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import api from '../api/client'
import { tokens, fs } from '../theme'
import Kick from '../components/ui/Kick'
import Panel from '../components/ui/Panel'
import { useToast } from '../components/ui/Toast'
import { useAuthStore } from '../store/authStore'
import { TIER_LABELS, Tier } from '../constants/tiers'

interface Settings {
  min_profit_margin_percent: number
  exclude_less_than_amount: number
  notify_telegram: boolean
  notify_browser_push: boolean
  auto_refresh_enabled: boolean
}

interface TelegramStatus {
  is_linked: boolean
  telegram_username: string | null
}

interface LinkCode {
  code: string
  ttl_seconds: number
  bot_username: string
  instruction: string
}

// ── окна статистики: ключ БД → подпись прототипа ─────────────────────────────
const WIN_LABEL: Record<string, string> = { '24h': '24ч', '48h': '48ч', '7d': '7д', '30d': '30д' }
const WIN_ORDER = ['24h', '48h', '7d', '30d']
const winText = (arr?: string[]) => {
  if (!arr || arr.length === 0) return '—'
  const t = WIN_ORDER.filter((k) => arr.includes(k)).map((k) => WIN_LABEL[k] ?? k).join(' · ')
  return t || '—'
}

const fmtDate = (iso: string | null) => {
  if (!iso) return 'бессрочно'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// ── .switch — тумблер настроек 30×16 (base.css:442-462) ──────────────────────
function TumblerSwitch({
  checked, onChange, disabled, label,
}: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: ReactNode }) {
  const trans = `background-color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}`
  return (
    <Box
      component="label"
      sx={{
        display: 'inline-flex', alignItems: 'center', gap: '10px', position: 'relative',
        cursor: disabled ? 'not-allowed' : 'pointer',
        '& input:checked + .sl': { background: tokens.goldDim, borderColor: tokens.goldLine },
        '& input:checked + .sl::before': { transform: 'translateX(14px)', background: tokens.goldAccent },
        '& input:focus-visible + .sl': { outline: `2px solid ${tokens.gold}`, outlineOffset: '1px' },
        '& input:checked ~ .lb': { color: tokens.text0 },
        '& input:disabled + .sl': { opacity: 0.45 },
        '& input:disabled ~ .lb': { color: tokens.text2 },
        ...(disabled ? {} : { '&:hover .lb': { color: tokens.text0 } }),
      }}
    >
      <Box
        component="input"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        sx={{ position: 'absolute', opacity: 0, width: '1px', height: '1px' }}
      />
      <Box
        component="span"
        className="sl"
        aria-hidden="true"
        sx={{
          flex: 'none', width: 30, height: 16, position: 'relative',
          background: tokens.bg2, border: `1px solid ${tokens.borderHi}`, borderRadius: 1, transition: trans,
          '&::before': {
            content: '""', position: 'absolute', top: '2px', left: '2px', width: 10, height: 10,
            background: tokens.text2,
            transition: `transform ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
          },
        }}
      />
      <Box
        component="span"
        className="lb"
        sx={{ fontSize: fs.f125, color: tokens.text1, transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}` }}
      >
        {label}
      </Box>
    </Box>
  )
}

// ── .panel + .sp-h/.sp-b — панель настроек с шапкой и телом ───────────────────
function SetPanel({ title, tag, children }: { title: ReactNode; tag?: ReactNode; children: ReactNode }) {
  return (
    <Panel>
      <Box
        sx={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '11px 16px', borderBottom: `1px solid ${tokens.border}`,
        }}
      >
        <Box
          component="h2"
          sx={{
            m: 0, fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f12,
            letterSpacing: '0.14em', textTransform: 'uppercase', color: tokens.text1,
            display: 'inline-flex', alignItems: 'center', gap: '8px',
          }}
        >
          {title}
        </Box>
        {tag != null && <Box sx={{ marginLeft: 'auto' }}>{tag}</Box>}
      </Box>
      <Box sx={{ padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {children}
      </Box>
    </Panel>
  )
}

// ── .chip.ok / .chip.off — статус-чип привязки ───────────────────────────────
function StateChip({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <Box
      component="span"
      className="mono"
      sx={{
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        fontSize: fs.f11, fontWeight: ok ? 600 : 500, padding: '2px 8px', borderRadius: 1,
        border: `1px solid ${ok ? tokens.successLine : tokens.borderHi}`,
        background: ok ? tokens.successDim : 'transparent',
        color: ok ? tokens.success : tokens.text2,
      }}
    >
      {ok && <Box component="span" sx={{ width: 6, height: 6, background: 'currentColor', boxShadow: '0 0 6px currentColor' }} />}
      {children}
    </Box>
  )
}

// ── .kv — строка ключ-значение панели тарифа ─────────────────────────────────
function Kv({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: 'on' | 'off' }) {
  return (
    <Box
      sx={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px',
        padding: '6px 0', borderBottom: `1px solid ${tokens.border}`,
        '&:last-of-type': { borderBottom: 0 },
      }}
    >
      <Box component="span" sx={{ fontSize: fs.f12, color: tokens.text2 }}>{k}</Box>
      <Box
        component="span"
        className="mono"
        sx={{
          fontSize: fs.f125, textAlign: 'right',
          color: tone === 'on' ? tokens.success : tone === 'off' ? tokens.text2 : tokens.text0,
        }}
      >
        {v}
      </Box>
    </Box>
  )
}

export default function SettingsPage() {
  const user = useAuthStore((s) => s.user)
  const { showToast } = useToast()

  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [dirty, setDirty]       = useState(false)
  const [error, setError]       = useState<string | null>(null)

  // Telegram
  const [tgStatus, setTgStatus]       = useState<TelegramStatus | null>(null)
  const [linkCode, setLinkCode]       = useState<LinkCode | null>(null)
  const [codeTimer, setCodeTimer]     = useState(0)
  const [codeLoading, setCodeLoading] = useState(false)
  const [unlinkArmed, setUnlinkArmed] = useState(false)
  const armRef = useRef<number | undefined>(undefined)

  const loadTgStatus = useCallback(async () => {
    try {
      const { data } = await api.get<TelegramStatus>('/telegram/status')
      setTgStatus(data)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    Promise.all([
      api.get('/settings').then(({ data }) => setSettings(data)),
      loadTgStatus(),
    ])
      .catch(() => setError('Не удалось загрузить настройки'))
      .finally(() => setLoading(false))
  }, [loadTgStatus])

  // Таймер обратного отсчёта для кода привязки
  useEffect(() => {
    if (codeTimer <= 0) {
      if (codeTimer === 0 && linkCode) setLinkCode(null) // код истёк
      return
    }
    const t = setInterval(() => setCodeTimer((s) => s - 1), 1000)
    return () => clearInterval(t)
  }, [codeTimer, linkCode])

  // Опрос статуса привязки пока код показан
  useEffect(() => {
    if (!linkCode) return
    const t = setInterval(() => { loadTgStatus() }, 5000)
    return () => clearInterval(t)
  }, [linkCode, loadTgStatus])

  // Реакция на успешную привязку — закрыть код
  useEffect(() => {
    if (tgStatus?.is_linked && linkCode) {
      setLinkCode(null)
      setCodeTimer(0)
    }
  }, [tgStatus?.is_linked, linkCode])

  const update = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSettings((s) => (s ? { ...s, [k]: v } : s))
    setDirty(true)
  }

  const handleSave = async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    const payload: Settings = {
      ...settings,
      min_profit_margin_percent: clamp(Math.round(Number(settings.min_profit_margin_percent) || 0), 0, 100),
      exclude_less_than_amount: Math.max(1, Math.round(Number(settings.exclude_less_than_amount) || 1)),
    }
    try {
      await api.put('/settings', payload)
      setSettings(payload)
      setDirty(false)
      showToast('Сохранено')
    } catch {
      setError('Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  const handleGetCode = async () => {
    setCodeLoading(true)
    try {
      const { data } = await api.get<LinkCode>('/telegram/link-code')
      setLinkCode(data)
      setCodeTimer(data.ttl_seconds)
    } catch {
      setError('Не удалось получить код. Попробуйте позже.')
    } finally {
      setCodeLoading(false)
    }
  }

  const handleUnlink = async () => {
    try {
      await api.delete('/telegram/unlink')
      setTgStatus({ is_linked: false, telegram_username: null })
      setLinkCode(null)
    } catch {
      setError('Не удалось отвязать Telegram')
    }
  }

  // .dbtn armConfirm — двухшаговое подтверждение отвязки
  const onUnlinkClick = () => {
    if (unlinkArmed) {
      setUnlinkArmed(false)
      window.clearTimeout(armRef.current)
      handleUnlink()
    } else {
      setUnlinkArmed(true)
      window.clearTimeout(armRef.current)
      armRef.current = window.setTimeout(() => setUnlinkArmed(false), 3000)
    }
  }

  const handleCopyCode = () => {
    if (!linkCode) return
    try {
      navigator.clipboard?.writeText(`/link ${linkCode.code}`)?.catch(() => {})
    } catch { /* ignore */ }
    showToast(`Скопировано: /link ${linkCode.code}`)
  }

  const fmtTimer = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  const pagecolSx = { display: 'flex', flexDirection: 'column', gap: '12px' } as const
  // .setcols — двухколоночная сетка панелей (settings.html), на узком экране — 1 колонка
  const setcolsSx = { display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: '12px', alignItems: 'start', maxWidth: 1160 } as const
  // .scol — колонка панелей
  const scolSx = { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 } as const

  // ── заголовок страницы (.pg-h) ─────────────────────────────────────────────
  const header = (
    <Box sx={{ background: tokens.bg1, border: `1px solid ${tokens.border}`, borderRadius: 1 }}>
      <Box sx={{ padding: '14px 18px 12px' }}>
        <Kick>Настройки // Trader_01</Kick>
        <Typography component="h1" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f26, letterSpacing: '0.03em', lineHeight: 1.05, mt: '3px' }}>
          Настройки
        </Typography>
        <Typography sx={{ fontSize: fs.f12, color: tokens.text2, mt: '4px', maxWidth: '72ch' }}>
          Критерий выгодности, уведомления, привязка Telegram и тариф аккаунта.
        </Typography>
      </Box>
    </Box>
  )

  if (loading) {
    return (
      <Box sx={pagecolSx}>
        {header}
        <Box sx={setcolsSx}>
          {[0, 1].map((col) => (
            <Box key={col} sx={scolSx}>
              {[0, 1].map((i) => (
                <Panel key={i}>
                  <Box sx={{ padding: '11px 16px', borderBottom: `1px solid ${tokens.border}` }}>
                    <Skeleton variant="rounded" width={140} height={13} />
                  </Box>
                  <Box sx={{ padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <Skeleton variant="rounded" height={18} />
                    <Skeleton variant="rounded" height={18} width="70%" />
                    <Skeleton variant="rounded" height={32} width={160} />
                  </Box>
                </Panel>
              ))}
            </Box>
          ))}
        </Box>
      </Box>
    )
  }

  const linked = !!tgStatus?.is_linked
  const margin = settings?.min_profit_margin_percent ?? 0

  // .note-box — живой критерий выгодности (пересчитывается при вводе)
  const critNote = (
    <Box sx={{ background: tokens.goldDim, border: `1px solid ${tokens.goldLine}`, borderRadius: 1, padding: '9px 11px', fontSize: fs.f12, color: tokens.text1, lineHeight: 1.5 }}>
      Уведомления приходят только по лотам с прибылью выше критерия выгодности{' '}
      <Box component="b" className="mono" sx={{ color: tokens.goldAccent, fontWeight: 600 }}>{margin} %</Box>{' '}
      из панели «Аналитика».
    </Box>
  )

  const tierName = user?.tier ? (TIER_LABELS[user.tier as Tier] ?? user.tier) : '—'
  const favLimit = user?.favorites_limit_override ?? user?.watchlist_limit ?? null

  return (
    <Box sx={pagecolSx}>
      {header}

      {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}

      <Box sx={setcolsSx}>
      {/* ── левая колонка (.scol): Аналитика + Telegram ──────────────────── */}
      <Box sx={scolSx}>

      {/* ── Аналитика (критерий выгодности) ──────────────────────────────── */}
      <SetPanel title="Аналитика">
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <Kick component="label">Критерий выгодности (%)</Kick>
          <TextField
            type="number"
            size="small"
            value={settings?.min_profit_margin_percent ?? ''}
            onChange={(e) => update('min_profit_margin_percent', Number(e.target.value))}
            inputProps={{ className: 'mono', min: 0, max: 100, step: 1 }}
            sx={{ maxWidth: 300 }}
          />
          <Box component="span" sx={{ fontSize: fs.f11, color: tokens.text2, lineHeight: 1.4 }}>
            Минимальная маржа для сигнала: лоты с прибылью ниже порога не попадают в «выгодные», сигналы и Telegram-уведомления.
          </Box>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <Kick component="label">Минимальное количество в лоте</Kick>
          <TextField
            type="number"
            size="small"
            value={settings?.exclude_less_than_amount ?? ''}
            onChange={(e) => update('exclude_less_than_amount', Number(e.target.value))}
            inputProps={{ className: 'mono', min: 1, step: 1 }}
            sx={{ maxWidth: 300 }}
          />
          <Box component="span" sx={{ fontSize: fs.f11, color: tokens.text2, lineHeight: 1.4 }}>
            Игнорировать лоты меньше N штук.
          </Box>
        </Box>

        <TumblerSwitch
          checked={settings?.auto_refresh_enabled ?? true}
          onChange={(v) => update('auto_refresh_enabled', v)}
          label="Автоматическое обновление данных"
        />

        <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Button variant="contained" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </Button>
          {dirty && !saving && (
            <Box component="span" sx={{ fontSize: fs.f11, color: tokens.warning, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <Box component="span" sx={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
              Не сохранено
            </Box>
          )}
        </Box>
      </SetPanel>

      {/* ── Telegram ─────────────────────────────────────────────────────── */}
      <SetPanel
        title={<><TelegramIcon sx={{ fontSize: 16, color: tokens.brandTelegram }} />Telegram</>}
        tag={<StateChip ok={linked}>{linked ? 'привязан' : 'не привязан'}</StateChip>}
      >
        {linked ? (
          <>
            {critNote}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <StateChip ok>@{tgStatus?.telegram_username ?? user?.telegram_username ?? 'linked'}</StateChip>
              <Box component="span" sx={{ flex: 1, minWidth: '16ch', fontSize: fs.f12, color: tokens.text1 }}>
                Уведомления о выгодных лотах включены — бот пишет, когда профит выше критерия.
              </Box>
              <Box
                component="button"
                type="button"
                onClick={onUnlinkClick}
                sx={{
                  display: 'inline-flex', alignItems: 'center', gap: '6px', height: 28, padding: '0 8px',
                  border: `1px solid ${unlinkArmed ? tokens.dangerLine : tokens.border}`, borderRadius: 1,
                  background: unlinkArmed ? tokens.dangerDim : tokens.bg2,
                  color: unlinkArmed ? tokens.danger : tokens.text2,
                  fontFamily: tokens.fontHead, fontWeight: 600, fontSize: fs.f11, letterSpacing: '0.06em', textTransform: 'uppercase',
                  cursor: 'pointer',
                  transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
                  '&:hover': { color: tokens.danger, borderColor: tokens.dangerLine },
                }}
              >
                {unlinkArmed ? 'Точно отвязать?' : 'Отвязать'}
              </Box>
            </Box>
          </>
        ) : linkCode ? (
          <>
            <Typography sx={{ m: 0, fontSize: fs.f12, color: tokens.text1, lineHeight: 1.5 }}>
              Отправь эту команду боту{' '}
              <Box component="b" sx={{ color: tokens.goldAccent, fontWeight: 600 }}>@{linkCode.bot_username}</Box>{' '}
              — привязка произойдёт автоматически.
            </Typography>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', background: tokens.bg2, border: `1px solid ${tokens.goldLine}`, borderRadius: 1, padding: '10px 12px' }}>
              <Box component="span" className="mono" sx={{ flex: 1, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.1em', color: tokens.goldAccent, whiteSpace: 'nowrap' }}>
                /link {linkCode.code}
              </Box>
              <Tooltip title="Скопировать">
                <IconButton size="small" onClick={handleCopyCode} aria-label="Скопировать команду">
                  <ContentCopyIcon sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Box component="span" className="mono" sx={{ fontSize: fs.f12, color: codeTimer < 60 ? tokens.warning : tokens.text2 }}>
                Код действителен: {fmtTimer(codeTimer)}
              </Box>
              <Button variant="outlined" size="small" onClick={handleGetCode} disabled={codeLoading} sx={{ marginLeft: 'auto' }}>
                Новый код
              </Button>
            </Box>
          </>
        ) : (
          <>
            <Typography sx={{ m: 0, fontSize: fs.f12, color: tokens.text1, lineHeight: 1.5 }}>
              Привяжи Telegram-аккаунт — бот{' '}
              <Box component="b" sx={{ color: tokens.goldAccent, fontWeight: 600 }}>@sc_trading_bot</Box>{' '}
              пришлёт сигнал, когда на рынке появится лот выгоднее твоего критерия.
            </Typography>
            {critNote}
            <Box>
              <Button variant="contained" onClick={handleGetCode} disabled={codeLoading}>
                {codeLoading ? 'Генерация…' : 'Получить код привязки'}
              </Button>
            </Box>
          </>
        )}
      </SetPanel>

      </Box>
      {/* ── правая колонка (.scol): Уведомления + Тариф ──────────────────── */}
      <Box sx={scolSx}>

      {/* ── Уведомления ──────────────────────────────────────────────────── */}
      <SetPanel title="Уведомления">
        <Box>
          <TumblerSwitch
            checked={linked && !!settings?.notify_telegram}
            disabled={!linked}
            onChange={(v) => update('notify_telegram', v)}
            label="Уведомления в Telegram"
          />
          {!linked && (
            <Box component="span" sx={{ display: 'block', mt: '5px', pl: '40px', fontSize: fs.f11, color: tokens.text2, lineHeight: 1.4 }}>
              Станет доступно после привязки Telegram-аккаунта.
            </Box>
          )}
        </Box>

        <TumblerSwitch
          checked={settings?.notify_browser_push ?? false}
          onChange={(v) => update('notify_browser_push', v)}
          label="Browser Push"
        />
      </SetPanel>

      {/* ── Тариф ────────────────────────────────────────────────────────── */}
      <SetPanel title="Тариф">
        <Box>
          <Kv
            k="Тариф"
            v={
              <Box component="span" sx={{ fontFamily: tokens.fontHead, fontWeight: 700, fontSize: fs.f11, letterSpacing: '0.1em', color: tokens.goldAccent, border: `1px solid ${tokens.goldLine}`, background: tokens.goldDim, padding: '3px 9px', borderRadius: 1, whiteSpace: 'nowrap' }}>
                {tierName}
              </Box>
            }
          />
          {favLimit != null && <Kv k="Лимит избранного" v={`${favLimit} предметов`} />}
          <Kv k="Окна графиков" v={winText(user?.stats_windows)} />
          <Kv
            k="Аддон «Радар рынка»"
            v={user?.has_market_radar_addon ? 'подключён' : 'не подключён'}
            tone={user?.has_market_radar_addon ? 'on' : 'off'}
          />
          <Kv k="Действует до" v={fmtDate(user?.tier_expires_at ?? null)} />
        </Box>
        <Box component="span" sx={{ display: 'block', fontSize: fs.f11, color: tokens.text2, lineHeight: 1.4 }}>
          Смена тарифа — через администратора.
        </Box>
      </SetPanel>

      </Box>
      </Box>
    </Box>
  )
}

import { useNavigate } from 'react-router-dom'
import { Box, BoxProps, Button, Stack } from '@mui/material'
import { tokens, fs, QUALITY_COLORS } from '../theme'
import { fmtP, fmtCompact } from '../utils/format'
import DiamondLogo from '../components/ui/DiamondLogo'
import Kick from '../components/ui/Kick'

const T = tokens

// Пульсирующая точка «live» (эталон base.css @keyframes pulse)
const pulseDot = {
  '@keyframes pubPulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
  animation: 'pubPulse 2s infinite',
} as const

// Центрирующая обёртка секций (.pub-wrap: max 1160, padding 0 32)
function Wrap({ sx, ...rest }: BoxProps) {
  return <Box sx={[{ maxWidth: 1160, mx: 'auto', px: '32px' }, ...(Array.isArray(sx) ? sx : sx ? [sx] : [])]} {...rest} />
}

// Фолбэк-глиф иконки предмета (буква на цвете качества) — эталон .fb
function Glyph({ letter, quality, size }: { letter: string; quality: string; size: number }) {
  return (
    <Box
      aria-hidden="true"
      sx={{
        width: size, height: size, flex: 'none', display: 'grid', placeItems: 'center',
        fontFamily: T.fontHead, fontWeight: 700, fontSize: size * 0.42,
        color: T.bg0, background: QUALITY_COLORS[quality] ?? QUALITY_COLORS.default,
        border: `1px solid ${T.border}`,
      }}
    >
      {letter}
    </Box>
  )
}

// ─── статичный пример живого сигнала для hero-виджета ────────────────────────
const HERO_SIGNAL = {
  nameRu: 'Гравиколлапс', quality: 'legend', qualityRu: 'Легенда', region: 'RU',
  median7d: 1_480_000, bestPer: 1_190_000, profit: 215_600, updatedMin: 3,
}

// ─── статичные иллюстрации фич (собраны как в прототипе из данных системы) ────
const ILL_LOTS = [
  { name: 'Гравиколлапс', per: 1_190_000, profit: 215_600, on: true },
  { name: 'Пружина мутанта', per: 640_000, profit: 98_000, on: false },
  { name: 'Медуза', per: 410_000, profit: 57_500, on: false },
]
const ILL_SIGS = [
  { name: 'Гравиколлапс', profit: 215_600 },
  { name: 'Кристаллический шип', profit: 132_000 },
  { name: 'Вспышка', profit: 74_300 },
]

const STATS = [
  { value: '5', unit: 'мин', label: 'цикл обновления данных', mono: false },
  { value: '2 236', unit: '', label: 'предметов в базе', mono: false },
  { value: '4', unit: 'региона', label: 'RU · EU · NA · SEA', mono: true },
  { value: '24/7', unit: '', label: 'непрерывный мониторинг', mono: false },
]

const STEPS = [
  { n: '01', title: 'Добавь в избранное', text: 'Выбери предметы из каталога — до 25 позиций под постоянным наблюдением системы.' },
  { n: '02', title: 'Получай сигналы', text: 'Терминал сравнивает каждый новый лот с медианой и сообщает о дешёвых сразу после среза.' },
  { n: '03', title: 'Перепродавай с прибылью', text: 'Выкупай ниже рынка и выставляй по расчётной цене — прибыль после комиссии уже посчитана.' },
]

interface Plan {
  name: string; num: string; unit: string; hot?: boolean; popular?: boolean
  rows: { k: string; v: string; kind?: 'ok' | 'no' }[]
}
const PLANS: Plan[] = [
  {
    name: 'Базовая', num: '6', unit: 'предметов в избранном',
    rows: [
      { k: 'окна графиков', v: '24ч · 48ч' },
      { k: 'раздел «Лоты»', v: 'закрыт', kind: 'no' },
      { k: 'лента сигналов', v: 'включена', kind: 'ok' },
      { k: 'радар рынка', v: 'аддон', kind: 'no' },
    ],
  },
  {
    name: 'Продвинутая', num: '10', unit: 'предметов в избранном',
    rows: [
      { k: 'окна графиков', v: 'до 7 дней' },
      { k: 'раздел «Лоты»', v: 'закрыт', kind: 'no' },
      { k: 'лента сигналов', v: 'включена', kind: 'ok' },
      { k: 'радар рынка', v: 'аддон', kind: 'no' },
    ],
  },
  {
    name: 'Продвинутая+', num: '20', unit: 'предметов в избранном', hot: true, popular: true,
    rows: [
      { k: 'окна графиков', v: 'до 30 дней' },
      { k: 'раздел «Лоты»', v: 'открыт', kind: 'ok' },
      { k: 'лента сигналов', v: 'включена', kind: 'ok' },
      { k: 'радар рынка', v: 'аддон', kind: 'no' },
    ],
  },
  {
    name: 'Продвинутая Макс', num: '25', unit: 'предметов в избранном',
    rows: [
      { k: 'окна графиков', v: 'до 30 дней' },
      { k: 'раздел «Лоты»', v: 'открыт', kind: 'ok' },
      { k: 'лента сигналов', v: 'включена', kind: 'ok' },
      { k: 'радар рынка', v: 'аддон', kind: 'no' },
    ],
  },
]

export default function LandingPage() {
  const navigate = useNavigate()
  const isLoggedIn = !!localStorage.getItem('access_token')

  const scrollToFeatures = () =>
    document.getElementById('features')?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: T.bg0, position: 'relative' }}>

      {/* ── фоновый слой .pub-bg: ромб-сетка + верхнее золотое свечение ──────── */}
      <Box aria-hidden="true" sx={{
        position: 'fixed', inset: 0, zIndex: -1, pointerEvents: 'none',
        background: [
          `radial-gradient(ellipse 62% 44% at 50% -14%, ${T.goldDim}, transparent 68%)`,
          `repeating-linear-gradient(45deg, ${T.grid} 0 1px, transparent 1px 44px)`,
          `repeating-linear-gradient(-45deg, ${T.grid} 0 1px, transparent 1px 44px)`,
        ].join(','),
      }} />

      {/* ── публичный хедер .pub-top: плоский div 48px, НЕ AppBar ────────────── */}
      <Box component="header" sx={{
        position: 'fixed', top: 0, left: 0, right: 0, height: T.navH, zIndex: T.z.nav,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
        px: '24px', background: T.bg1, borderBottom: `1px solid ${T.border}`,
      }}>
        <Box
          component="a" href="/" aria-label="SC Trading — на главную"
          onClick={(e: React.MouseEvent) => { e.preventDefault(); navigate('/') }}
          sx={{ display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none', flex: 'none' }}
        >
          <DiamondLogo size={28} />
          <Box sx={{ lineHeight: 1.02, display: 'flex', flexDirection: 'column' }}>
            <Box component="b" sx={{ fontFamily: T.fontHead, fontWeight: 700, fontSize: fs.f15, letterSpacing: '0.08em', color: T.text0 }}>
              SC TRADING
            </Box>
            <Box component="i" sx={{ fontStyle: 'normal', fontFamily: T.fontHead, fontWeight: 600, fontSize: fs.f10, letterSpacing: '0.24em', color: T.text2, textTransform: 'uppercase' }}>
              Zone Terminal
            </Box>
          </Box>
        </Box>

        {isLoggedIn ? (
          <Button variant="contained" size="small" onClick={() => navigate('/app/monitoring')}>
            Войти в терминал
          </Button>
        ) : (
          <Stack direction="row" spacing={1.25} alignItems="center">
            <Button variant="outlined" size="small" onClick={() => navigate('/login')}>Войти</Button>
            <Button variant="contained" size="small" onClick={() => navigate('/register')}>Регистрация</Button>
          </Stack>
        )}
      </Box>

      <Box component="main" sx={{ pt: `${T.navH}px`, pb: '96px' }}>

        {/* ══════════ HERO ══════════ */}
        <Wrap component="section" aria-label="Главный экран" sx={{
          display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 384px', gap: '56px',
          alignItems: 'center', pt: '76px', pb: '60px',
        }}>
          <Box>
            {/* бейдж статуса */}
            <Box sx={{
              display: 'inline-flex', alignItems: 'center', gap: '9px', px: '12px', py: '5px',
              border: `1px solid ${T.goldLine}`, background: T.goldDim, borderRadius: 1,
              fontFamily: T.fontHead, fontWeight: 600, fontSize: fs.f11, letterSpacing: '0.18em',
              textTransform: 'uppercase', color: T.goldAccent,
            }}>
              <Box aria-hidden="true" sx={{ width: 6, height: 6, flex: 'none', background: T.success, boxShadow: `0 0 8px ${T.success}`, ...pulseDot }} />
              Система активна // регион RU
            </Box>

            {/* слоган — сплошным цветом (BAN-01: без gradient-text) */}
            <Box component="h1" sx={{
              fontFamily: T.fontHead, fontWeight: 700, fontSize: '64px', lineHeight: 0.96,
              letterSpacing: '0.045em', color: T.text0, m: '20px 0 12px',
            }}>
              TRADE THE ZONE.
            </Box>
            <Box aria-label="Аномалия, данные, профит" sx={{
              fontFamily: T.fontHead, fontWeight: 600, fontSize: '20px', letterSpacing: '0.22em',
              color: T.goldAccent, textTransform: 'uppercase',
            }}>
              Anomaly → Data → Profit
            </Box>

            <Box component="p" sx={{ m: '18px 0 0', fontSize: fs.f15, lineHeight: 1.7, color: T.text1, maxWidth: '52ch' }}>
              Терминал перепродажи для аукциона STALZONE: реальные цены по истории сделок,
              сигналы о лотах дешевле медианы и готовый расчёт прибыли после комиссии.
            </Box>

            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: '30px' }}>
              {isLoggedIn ? (
                <Button variant="contained" onClick={() => navigate('/app/monitoring')} sx={{ height: 40, px: '26px' }}>
                  Войти в терминал
                </Button>
              ) : (
                <Button variant="contained" onClick={() => navigate('/register')} sx={{ height: 40, px: '26px' }}>
                  Начать бесплатно
                </Button>
              )}
              <Button variant="outlined" onClick={scrollToFeatures} sx={{ height: 40, px: '20px' }}>
                Посмотреть возможности ↓
              </Button>
            </Stack>
          </Box>

          {/* живой виджет: продукт показывает себя сам (статичный пример) */}
          <Box component="aside" aria-label="Живой сигнал рынка" sx={{
            background: T.bg1, border: `1px solid ${T.border}`, borderTop: `2px solid ${T.gold}`, borderRadius: 1,
          }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', p: '10px 14px', borderBottom: `1px solid ${T.border}` }}>
              <Kick>Live // Сигнал рынка</Kick>
              <Box className="mono" sx={{ display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: fs.f11, color: T.text1 }}>
                <Box aria-hidden="true" sx={{ width: 6, height: 6, flex: 'none', background: T.success, boxShadow: `0 0 8px ${T.success}`, ...pulseDot }} />
                14:20
              </Box>
            </Box>

            <Box sx={{ p: '16px 16px 14px' }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px', mb: '14px' }}>
                <Glyph letter="Г" quality={HERO_SIGNAL.quality} size={44} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Box sx={{ display: 'block', fontSize: fs.f14, fontWeight: 600, color: T.text0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {HERO_SIGNAL.nameRu}
                  </Box>
                  <Box sx={{ display: 'flex', gap: '5px', mt: '4px' }}>
                    <Box component="span" sx={{
                      display: 'inline-flex', alignItems: 'center', gap: '5px', px: '6px', py: '1px', fontSize: fs.f105, fontWeight: 600,
                      color: QUALITY_COLORS[HERO_SIGNAL.quality], border: `1px solid ${T.goldLineSoft}`, borderRadius: 1,
                    }}>
                      <Box aria-hidden="true" sx={{ width: 6, height: 6, background: 'currentColor', boxShadow: '0 0 6px currentColor' }} />
                      {HERO_SIGNAL.qualityRu}
                    </Box>
                    <Box component="span" className="mono" sx={{ px: '6px', py: '1px', fontSize: fs.f105, fontWeight: 500, color: T.text1, border: `1px solid ${T.borderHi}`, borderRadius: 1 }}>
                      {HERO_SIGNAL.region}
                    </Box>
                  </Box>
                </Box>
              </Box>

              <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '7px 12px', alignItems: 'baseline' }}>
                <Box component="dt" sx={{ fontSize: fs.f11, color: T.text2, whiteSpace: 'nowrap' }}>медиана 7д</Box>
                <Box component="dd" className="mono" sx={{ m: 0, textAlign: 'right', fontSize: '24px', fontWeight: 700, lineHeight: 1.05, color: T.goldHighlight, textShadow: `0 0 18px ${T.goldGlow}` }}>
                  {fmtP(HERO_SIGNAL.median7d)}
                </Box>
                <Box component="dt" sx={{ fontSize: fs.f11, color: T.text2, whiteSpace: 'nowrap' }}>лучший лот</Box>
                <Box component="dd" className="mono" sx={{ m: 0, textAlign: 'right', fontSize: fs.f125, color: T.text0 }}>
                  {fmtP(HERO_SIGNAL.bestPer)} <Box component="span" sx={{ color: T.text2, fontSize: fs.f105 }}>/шт</Box>
                </Box>
                <Box component="dt" sx={{ fontSize: fs.f11, color: T.text2, whiteSpace: 'nowrap' }}>профит</Box>
                <Box component="dd" className="mono" sx={{ m: 0, textAlign: 'right', fontSize: fs.f125, color: T.success, fontWeight: 500 }}>
                  +{fmtP(HERO_SIGNAL.profit)} <Box component="span" sx={{ color: T.text2, fontSize: fs.f105 }}>/шт</Box>
                </Box>
              </Box>
            </Box>

            <Box className="mono" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', p: '8px 14px', borderTop: `1px solid ${T.border}`, fontSize: fs.f105, color: T.text2 }}>
              <span>обновлено {HERO_SIGNAL.updatedMin} мин назад</span>
              <span>сигнал 1/1</span>
            </Box>
          </Box>
        </Wrap>

        {/* ══════════ СТАТ-ПОЛОСА ══════════ */}
        <Wrap component="section" aria-label="Ключевые цифры">
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '1px', background: T.border, border: `1px solid ${T.border}`, borderRadius: 1, overflow: 'hidden' }}>
            {STATS.map((s) => (
              <Box key={s.label} sx={{ background: T.bg1, p: '18px 22px' }}>
                <Box component="span" className="mono" sx={{ display: 'block', fontWeight: 500, fontSize: '24px', color: T.text0 }}>
                  {s.value}
                  {s.unit && <Box component="i" sx={{ fontStyle: 'normal', fontFamily: T.fontHead, fontWeight: 700, fontSize: fs.f11, letterSpacing: '0.1em', color: T.goldAccent, textTransform: 'uppercase', ml: '3px' }}>{s.unit}</Box>}
                </Box>
                <Box component="span" className={s.mono ? 'mono' : undefined} sx={{ display: 'block', mt: '5px', fontSize: fs.f12, color: T.text2 }}>
                  {s.label}
                </Box>
              </Box>
            ))}
          </Box>
        </Wrap>

        {/* ══════════ ФИЧИ ══════════ */}
        <Wrap component="section" id="features" sx={{ mt: '88px', scrollMarginTop: `${T.navH + 20}px` }}>
          <Box sx={{ mb: '24px' }}>
            <Box component="h2" sx={{ fontFamily: T.fontHead, fontWeight: 700, fontSize: '32px', letterSpacing: '0.05em', lineHeight: 1.05, color: T.text0 }}>
              Что внутри терминала
            </Box>
            <Box component="p" sx={{ mt: '7px', fontSize: fs.f13, color: T.text2, maxWidth: '70ch' }}>
              Три контура работы с рынком — от сырых срезов аукциона до готового решения «выкупать или нет».
            </Box>
          </Box>

          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '1px', background: T.border, border: `1px solid ${T.border}`, borderRadius: 1, overflow: 'hidden' }}>
            {/* фича 1 — Мониторинг */}
            <Box sx={{ background: T.bg1, p: '18px 20px 22px', minWidth: 0 }}>
              <Box aria-hidden="true" sx={{ height: 136, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 1, p: '10px 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '3px', overflow: 'hidden', mb: '16px' }}>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 72px 78px', gap: '8px', px: '8px', py: '4px', fontFamily: T.fontHead, fontWeight: 600, fontSize: fs.f10, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.text2, borderBottom: `1px solid ${T.border}` }}>
                  <span>предмет</span><Box component="span" sx={{ textAlign: 'right' }}>цена/шт</Box><Box component="span" sx={{ textAlign: 'right' }}>профит</Box>
                </Box>
                {ILL_LOTS.map((r) => (
                  <Box key={r.name} className="mono" sx={{
                    display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 72px 78px', gap: '8px', px: '8px', py: '4px',
                    fontSize: fs.f105, color: r.on ? T.goldAccent : T.text1, borderRadius: 1,
                    ...(r.on && { background: T.goldDim, boxShadow: `inset 2px 0 0 ${T.goldHighlight}` }),
                  }}>
                    <Box component="span" sx={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</Box>
                    <Box component="span" sx={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtCompact(r.per)}</Box>
                    <Box component="span" sx={{ textAlign: 'right', whiteSpace: 'nowrap', color: T.success }}>+{fmtCompact(r.profit)}</Box>
                  </Box>
                ))}
              </Box>
              <Kick sx={{ color: T.text2 }}>Monitor</Kick>
              <Box component="h3" sx={{ fontFamily: T.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.text0, m: '8px 0' }}>Мониторинг рынка</Box>
              <Box component="p" sx={{ m: 0, fontSize: fs.f125, lineHeight: 1.6, color: T.text1 }}>
                Срез аукциона каждые 5 минут: активные лоты, выкупы между срезами, отсев истекающего мусора. Ты видишь рынок раньше конкурентов.
              </Box>
            </Box>

            {/* фича 2 — Аналитика */}
            <Box sx={{ background: T.bg1, p: '18px 20px 22px', minWidth: 0 }}>
              <Box aria-hidden="true" sx={{ height: 136, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 1, p: '10px 12px', display: 'flex', mb: '16px' }}>
                <Box component="svg" viewBox="0 0 240 100" preserveAspectRatio="none" sx={{ width: '100%', height: '100%', display: 'block' }}>
                  <g stroke={T.grid}>
                    <line x1="0" y1="25" x2="240" y2="25" /><line x1="0" y1="50" x2="240" y2="50" /><line x1="0" y1="75" x2="240" y2="75" />
                  </g>
                  <path d="M0,62 L30,58 L60,66 L90,50 L120,56 L150,42 L180,48 L210,38 L240,44 L240,86 L210,80 L180,88 L150,78 L120,90 L90,84 L60,92 L30,86 L0,90 Z" fill={T.goldDim} stroke={T.goldLineSoft} />
                  <path d="M0,76 L30,72 L60,79 L90,67 L120,73 L150,60 L180,68 L210,59 L240,64" fill="none" stroke={T.goldAccent} strokeWidth="1.5" />
                  <line x1="0" y1="70" x2="240" y2="70" stroke={T.gold} strokeDasharray="5 4" />
                </Box>
              </Box>
              <Kick sx={{ color: T.text2 }}>Analyze</Kick>
              <Box component="h3" sx={{ fontFamily: T.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.text0, m: '8px 0' }}>Аналитика продаж</Box>
              <Box component="p" sx={{ m: 0, fontSize: fs.f125, lineHeight: 1.6, color: T.text1 }}>
                Медиана по реальным сделкам, коридор мин–макс, волатильность и лучший час для покупки и продажи. Цены из истории, а не из слухов.
              </Box>
            </Box>

            {/* фича 3 — Радар рынка (реальная фича, не «в разработке») */}
            <Box sx={{ background: T.bg1, p: '18px 20px 22px', minWidth: 0 }}>
              <Box aria-hidden="true" sx={{ height: 136, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 1, p: '10px 12px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '6px', overflow: 'hidden', mb: '16px' }}>
                {ILL_SIGS.map((s) => (
                  <Box key={s.name} sx={{ display: 'flex', alignItems: 'center', gap: '8px', p: '5px 9px', background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 1 }}>
                    <Box aria-hidden="true" sx={{ width: 6, height: 6, flex: 'none', background: T.success, boxShadow: `0 0 8px ${T.success}`, ...pulseDot }} />
                    <Box sx={{ flex: 1, minWidth: 0, fontSize: fs.f115, color: T.text0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</Box>
                    <Box className="mono" sx={{ flex: 'none', fontSize: fs.f105, fontWeight: 700, color: T.success, background: T.successDim, border: `1px solid ${T.successLine}`, px: '6px', py: '1px', borderRadius: 1 }}>
                      +{fmtCompact(s.profit)}
                    </Box>
                  </Box>
                ))}
              </Box>
              <Kick sx={{ color: T.text2 }}>Radar</Kick>
              <Box component="h3" sx={{ fontFamily: T.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.text0, m: '8px 0' }}>Радар рынка</Box>
              <Box component="p" sx={{ m: 0, fontSize: fs.f125, lineHeight: 1.6, color: T.text1 }}>
                Сканер всего аукциона, а не только избранного: находит лоты дешевле медианы с готовым расчётом прибыли после комиссии 5 %. Осталось выкупить и перевыставить.
              </Box>
            </Box>
          </Box>
        </Wrap>

        {/* ══════════ КАК ЭТО РАБОТАЕТ ══════════ */}
        <Wrap component="section" sx={{ mt: '88px' }}>
          <Box component="h2" sx={{ fontFamily: T.fontHead, fontWeight: 700, fontSize: '32px', letterSpacing: '0.05em', lineHeight: 1.05, color: T.text0, mb: '24px' }}>
            Как это работает
          </Box>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 40px 1fr 40px 1fr', alignItems: 'start' }}>
            {STEPS.map((st, i) => (
              <Box key={st.n} sx={{ display: 'contents' }}>
                <Box sx={{ borderTop: `1px solid ${T.borderHi}`, pt: '14px', minWidth: 0 }}>
                  <Box component="span" className="mono" sx={{ fontWeight: 700, fontSize: '26px', color: T.goldAccent }}>
                    {st.n}<Box component="em" sx={{ fontStyle: 'normal', fontSize: fs.f12, color: T.text2, fontWeight: 400 }}>/03</Box>
                  </Box>
                  <Box component="h3" sx={{ fontFamily: T.fontHead, fontWeight: 700, fontSize: fs.f16, letterSpacing: '0.05em', m: '8px 0 6px', color: T.text0 }}>{st.title}</Box>
                  <Box component="p" sx={{ m: 0, pr: '12px', color: T.text1, fontSize: fs.f125, lineHeight: 1.6 }}>{st.text}</Box>
                </Box>
                {i < STEPS.length - 1 && (
                  <Box aria-hidden="true" className="mono" sx={{ display: 'grid', placeItems: 'center', pt: '22px', color: T.goldSoft, fontSize: '18px' }}>→</Box>
                )}
              </Box>
            ))}
          </Box>
        </Wrap>

        {/* ══════════ ТАРИФЫ ══════════ */}
        <Wrap component="section" id="tariffs" sx={{ mt: '88px', scrollMarginTop: `${T.navH + 20}px` }}>
          <Box sx={{ mb: '24px' }}>
            <Box component="h2" sx={{ fontFamily: T.fontHead, fontWeight: 700, fontSize: '32px', letterSpacing: '0.05em', lineHeight: 1.05, color: T.text0 }}>Тарифы</Box>
            <Box component="p" sx={{ mt: '7px', fontSize: fs.f13, color: T.text2, maxWidth: '70ch' }}>
              Глубина аналитики растёт с тарифом. Доступ выдаётся по запросу — регистрация открывает базовый уровень сразу.
            </Box>
          </Box>

          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '1px', background: T.border, border: `1px solid ${T.border}`, borderRadius: 1, overflow: 'hidden' }}>
            {PLANS.map((pl) => (
              <Box key={pl.name} sx={{
                position: 'relative', background: pl.hot ? T.bg2 : T.bg1, p: '20px', display: 'flex', flexDirection: 'column', minWidth: 0,
                ...(pl.hot && { boxShadow: `inset 0 2px 0 ${T.goldHighlight}` }),
              }}>
                {pl.popular && (
                  <Box component="span" sx={{
                    position: 'absolute', top: 14, right: 16, fontFamily: T.fontHead, fontWeight: 700, fontSize: fs.f10, letterSpacing: '0.14em', textTransform: 'uppercase',
                    color: T.goldAccent, background: T.goldDim, border: `1px solid ${T.goldLine}`, px: '7px', py: '2px', borderRadius: 1,
                  }}>Популярный</Box>
                )}
                <Box component="h3" sx={{ fontFamily: T.fontHead, fontWeight: 700, fontSize: fs.f14, letterSpacing: '0.14em', textTransform: 'uppercase', color: pl.hot ? T.goldAccent : T.text1 }}>
                  {pl.name}
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: '7px', mt: '14px' }}>
                  <Box component="b" className="mono" sx={{ fontWeight: 700, fontSize: '30px', color: pl.hot ? T.goldAccent : T.text0, lineHeight: 1 }}>{pl.num}</Box>
                  <Box component="span" sx={{ fontSize: fs.f12, color: T.text2 }}>{pl.unit}</Box>
                </Box>
                <Box component="dl" sx={{ m: '14px 0 16px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '7px 10px', borderTop: `1px solid ${T.border}`, pt: '13px' }}>
                  {pl.rows.map((r) => (
                    <Box key={r.k} sx={{ display: 'contents' }}>
                      <Box component="dt" sx={{ fontSize: fs.f11, color: T.text2, whiteSpace: 'nowrap' }}>{r.k}</Box>
                      <Box component="dd" className="mono" sx={{ m: 0, textAlign: 'right', fontSize: fs.f115, whiteSpace: 'nowrap', color: r.kind === 'no' ? T.text2 : r.kind === 'ok' ? T.success : T.text0 }}>{r.v}</Box>
                    </Box>
                  ))}
                </Box>
                <Button
                  variant={pl.hot ? 'contained' : 'outlined'}
                  onClick={() => navigate('/register')}
                  sx={{ mt: 'auto', width: '100%', height: 32 }}
                >
                  Запросить доступ
                </Button>
              </Box>
            ))}
          </Box>
          <Box component="p" sx={{ mt: '12px', fontSize: fs.f12, color: T.text2 }}>
            «Радар рынка» — отдельный аддон к любому тарифу: сканер всего аукциона без привязки к избранному.
          </Box>
        </Wrap>
      </Box>

      {/* ══════════ ФУТЕР .pub-foot ══════════ */}
      <Box component="footer" sx={{
        borderTop: `1px solid ${T.border}`, background: T.bg1, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '16px', p: '14px 24px', fontFamily: T.fontMono, fontSize: fs.f105, letterSpacing: '0.04em', color: T.text2,
      }}>
        <Box component="span"><Box component="b" sx={{ color: T.text1, fontWeight: 500 }}>SC TRADING // ZONE TERMINAL</Box></Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Box
            component="a" href="/faq"
            onClick={(e: React.MouseEvent) => { e.preventDefault(); navigate('/faq') }}
            sx={{ color: T.text1, textDecoration: 'none', transition: `color ${T.motion.fast}ms ${T.motion.ease}`, '&:hover': { color: T.goldAccent } }}
          >
            Частые вопросы
          </Box>
          <Box component="span">Не аффилирован с EXBO Studio</Box>
        </Box>
      </Box>
    </Box>
  )
}

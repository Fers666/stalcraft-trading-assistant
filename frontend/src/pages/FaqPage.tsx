import { useNavigate } from 'react-router-dom'
import {
  Box, Typography, Accordion, AccordionSummary, AccordionDetails,
  Button, alpha,
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { tokens } from '../theme'

const {
  gold: G2, goldAccent: G3,
  bg0: BG0, bg1: BG1, bg2: BG2,
  text1: T1, text2: T2, border: BORDER,
} = tokens

interface FaqItem {
  q: string
  a: React.ReactNode
}

interface FaqGroup {
  title: string
  items: FaqItem[]
}

const tierRows = [
  { tier: 'Базовая',      fav: '6',  notif: 'нет', history: '24 часа',                       lots: 'нет' },
  { tier: 'Продвинутая',  fav: '10', notif: 'да',  history: '24ч + 48ч',                      lots: 'нет' },
  { tier: 'Продвинутая+', fav: '20', notif: 'да',  history: '24ч + 48ч + 7д',                 lots: 'да'  },
  { tier: 'Макс',         fav: '25', notif: 'да',  history: '24ч + 48ч + 7д + 30д',           lots: 'да'  },
]

function TierTable() {
  return (
    <Box sx={{
      mt: 1.5, mb: 1.5, overflowX: 'auto',
      border: `1px solid ${BORDER}`, borderRadius: '12px',
    }}>
      <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <Box component="thead">
          <Box component="tr">
            {['Тариф', 'Предметов в Избранном', 'Уведомления в Telegram', 'История продаж', 'Раздел «Лоты»'].map((h) => (
              <Box component="th" key={h} sx={{
                textAlign: 'left', padding: '8px 12px',
                background: BG1, color: T2, fontWeight: 600,
                fontSize: '0.68rem', letterSpacing: '0.06em', textTransform: 'uppercase',
                borderBottom: `1px solid ${BORDER}`,
              }}>
                {h}
              </Box>
            ))}
          </Box>
        </Box>
        <Box component="tbody">
          {tierRows.map((row) => (
            <Box component="tr" key={row.tier}>
              <Box component="td" sx={{ padding: '8px 12px', color: G3, fontWeight: 600, borderBottom: `1px solid ${BORDER}` }}>
                {row.tier}
              </Box>
              <Box component="td" sx={{ padding: '8px 12px', color: T1, borderBottom: `1px solid ${BORDER}` }}>{row.fav}</Box>
              <Box component="td" sx={{ padding: '8px 12px', color: T1, borderBottom: `1px solid ${BORDER}` }}>{row.notif}</Box>
              <Box component="td" sx={{ padding: '8px 12px', color: T1, borderBottom: `1px solid ${BORDER}` }}>{row.history}</Box>
              <Box component="td" sx={{ padding: '8px 12px', color: T1, borderBottom: `1px solid ${BORDER}` }}>{row.lots}</Box>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

const FAQ_GROUPS: FaqGroup[] = [
  {
    title: 'Общее',
    items: [
      {
        q: 'Что такое SC Trading?',
        a: 'SC Trading помогает зарабатывать на аукционе STALZONE. Показывает, сколько предмет стоит на самом деле (по реальным продажам, а не по тому, что просят продавцы), когда его выгоднее продать и за сколько он скорее всего уйдёт.',
      },
      {
        q: 'Какие данные используются и как часто обновляются?',
        a: 'Сервис следит за аукционом каждые несколько минут и запоминает, что и за сколько реально продалось. Все советы строятся только на реальных продажах — не на ценах лотов, которые просто висят и может никто не купит.',
      },
      {
        q: 'Как зарегистрироваться и получить доступ?',
        a: 'Регистрация открыта всем — после неё сразу появляется доступ на базовом тарифе. Нужна помощь — пиши в Telegram.',
      },
    ],
  },
  {
    title: 'Радар рынка и Избранное',
    items: [
      {
        q: 'Как добавить предмет в Избранное?',
        a: 'Нашёл нужный предмет в Каталоге — жми кнопку «в избранное». На странице Избранного появится вся аналитика по нему: цена, когда продавать, когда покупать. Можно сразу выбрать качество/заточку, если важен конкретный вариант предмета.',
      },
      {
        q: 'Что значат цифры на карточке предмета?',
        a: (
          <Box component="ul" sx={{ m: 0, pl: 2.5, '& li': { mb: 1 } }}>
            <li><b style={{ color: T1 }}>Быстро / Нормально / Выгодно</b> — три варианта цены: продать чуть дешевле и быстрее, по рынку, или подороже и подольше подождать. Рядом — сколько примерно ждать продажи по каждому варианту.</li>
            <li><b style={{ color: T1 }}>Риск</b> (низкий/умеренный/высокий) — насколько сильно скачет цена на этот предмет. Чем выше риск, тем меньше гарантий, что прогноз сбудется.</li>
            <li><b style={{ color: T1 }}>Точность прогноза</b> — зависит от того, сколько реальных продаж нашлось. Больше данных — точнее прогноз.</li>
          </Box>
        ),
      },
      {
        q: 'Радар рынка и Избранное — это одно и то же?',
        a: 'Нет. Избранное — твой личный список. Радар рынка — общий топ: что чаще всего отслеживают все пользователи сервиса и сколько по предмету сейчас выгодных лотов. Это отдельная штука, не входит в тариф — подключается отдельно админом.',
      },
    ],
  },
  {
    title: 'Тарифы и лимиты',
    items: [
      {
        q: 'Какие есть тарифы и чем они отличаются?',
        a: (
          <>
            <TierTable />
            <Typography sx={{ color: T1, fontSize: '0.875rem', lineHeight: 1.7 }}>
              Привязать Telegram можно на любом тарифе — тариф влияет только на то, будут ли приходить уведомления.
            </Typography>
          </>
        ),
      },
      {
        q: 'Как узнать свой тариф и как его повысить?',
        a: 'Тариф показан в навбаре рядом с ником. Хочешь повысить — пиши админу в Telegram.',
      },
    ],
  },
  {
    title: 'Telegram',
    items: [
      {
        q: 'Как привязать Telegram и какие уведомления будут приходить?',
        a: 'Зайди в Настройки → жми «Получить код» → отправь этот код боту командой /link <код>. Готово — если твой тариф поддерживает уведомления, бот будет писать про выгодные лоты по предметам из твоего Избранного.',
      },
      {
        q: 'Как отключить уведомления?',
        a: 'В Настройках выключи переключатель «Уведомления в Telegram». Привязка останется, бот просто перестанет писать. Отвязать аккаунт полностью можно там же.',
      },
    ],
  },
  {
    title: 'Графики и метрики',
    items: [
      {
        q: 'Как читать график цен?',
        a: 'График показывает только реальные продажи — то, что люди действительно купили, а не то, что продавцы просто выставили на продажу. Цифры честные.',
      },
      {
        q: 'Что значит качество и заточка (qlt/ptn)?',
        a: 'Качество — это редкость артефакта, от слабого к самому крутому: Обычный, Необычный, Особый, Ветеран, Мастер, Легендарный. Заточка — это улучшение предмета, от +1 до +15, или «Не точёный», если его не улучшали. Если выбрать конкретное качество/заточку в фильтре карточки — вся статистика будет именно по нему.',
      },
    ],
  },
]

export default function FaqPage() {
  const navigate   = useNavigate()
  const isLoggedIn = !!localStorage.getItem('access_token')

  return (
    <Box sx={{
      minHeight: '100vh', bgcolor: BG0,
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Subtle gold top glow */}
      <Box sx={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 280,
        pointerEvents: 'none',
        background: `radial-gradient(ellipse 50% 40% at 50% -10%, ${alpha(G2, 0.06)} 0%, transparent 70%)`,
      }} />

      {/* Header */}
      <Box sx={{
        px: 5, py: 2.5,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${BORDER}`,
        backdropFilter: 'blur(12px)',
        background: alpha(BG1, 0.7),
        position: 'relative', zIndex: 1,
      }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, cursor: 'pointer' }}
          onClick={() => navigate(isLoggedIn ? '/app/monitoring' : '/')}>
          <Box sx={{ width: 34, height: 34 }}>
            <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
              <defs>
                <linearGradient id="faq-gold" x1="0" y1="1" x2="1" y2="0">
                  <stop offset="0%" stopColor="#B78A2A" />
                  <stop offset="55%" stopColor="#D9AF37" />
                  <stop offset="100%" stopColor="#F2C94C" />
                </linearGradient>
                <clipPath id="faq-diamond">
                  <polygon points="17,1 33,17 17,33 1,17" />
                </clipPath>
              </defs>
              <polygon points="17,1 33,17 17,33 1,17" stroke="url(#faq-gold)" strokeWidth="1.5" fill="none" />
              <g clipPath="url(#faq-diamond)">
                <rect x="6" y="22" width="4" height="9" fill="url(#faq-gold)" opacity="0.55" />
                <rect x="11.5" y="18" width="4" height="13" fill="url(#faq-gold)" opacity="0.7" />
                <rect x="17" y="13" width="4" height="18" fill="url(#faq-gold)" opacity="0.85" />
                <rect x="22.5" y="8" width="4" height="23" fill="url(#faq-gold)" />
              </g>
            </svg>
          </Box>
          <Box>
            <Typography sx={{
              fontFamily: '"Rajdhani", sans-serif', fontWeight: 700,
              fontSize: '1.05rem', color: '#F5F5F5', letterSpacing: '0.08em', lineHeight: 1,
            }}>
              SC TRADING
            </Typography>
            <Typography sx={{ fontSize: '0.5rem', color: T2, letterSpacing: '0.15em', lineHeight: 1 }}>
              ZONE MARKET TERMINAL
            </Typography>
          </Box>
        </Box>
        <Button variant="outlined" size="small" onClick={() => navigate(isLoggedIn ? '/app/monitoring' : '/')}>
          {isLoggedIn ? 'Назад в терминал' : 'На главную'}
        </Button>
      </Box>

      {/* Content */}
      <Box sx={{ maxWidth: 760, mx: 'auto', px: 3, py: 6, position: 'relative', zIndex: 1 }}>
        <Typography sx={{
          fontFamily: '"Rajdhani", sans-serif',
          fontWeight: 700,
          fontSize: { xs: '2rem', md: '2.6rem' },
          letterSpacing: '0.04em',
          color: '#F5F5F5',
          mb: 1,
        }}>
          Частые вопросы
        </Typography>
        <Typography sx={{ color: T2, fontSize: '0.95rem', mb: 5 }}>
          Как пользоваться SC Trading — коротко и по делу.
        </Typography>

        {FAQ_GROUPS.map((group) => (
          <Box key={group.title} sx={{ mb: 4 }}>
            <Typography sx={{
              fontFamily: '"Rajdhani", sans-serif',
              fontWeight: 600,
              fontSize: '0.95rem',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: G3,
              mb: 1.5,
            }}>
              {group.title}
            </Typography>

            {group.items.map((item) => (
              <Accordion
                key={item.q}
                disableGutters
                sx={{
                  background: alpha(BG2, 0.65),
                  border: `1px solid ${BORDER}`,
                  borderRadius: '12px !important',
                  mb: 1,
                  backdropFilter: 'blur(12px)',
                  '&::before': { display: 'none' },
                  '&:hover': { borderColor: alpha(G2, 0.25) },
                }}
              >
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon sx={{ color: G3 }} />}
                  sx={{
                    '& .MuiAccordionSummary-content': { my: 0.5 },
                  }}
                >
                  <Typography sx={{ color: '#F5F5F5', fontWeight: 600, fontSize: '0.92rem' }}>
                    {item.q}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ borderTop: `1px solid ${BORDER}`, pt: 2 }}>
                  {typeof item.a === 'string' ? (
                    <Typography sx={{ color: T1, fontSize: '0.875rem', lineHeight: 1.7 }}>
                      {item.a}
                    </Typography>
                  ) : item.a}
                </AccordionDetails>
              </Accordion>
            ))}
          </Box>
        ))}

        <Box sx={{ textAlign: 'center', mt: 6 }}>
          <Typography sx={{ color: T2, fontSize: '0.85rem' }}>
            Не нашёл ответ? Напиши админу в Telegram.
          </Typography>
        </Box>
      </Box>
    </Box>
  )
}

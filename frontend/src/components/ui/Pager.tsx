import { Box, ButtonBase, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../theme'

// .pager — пагинация: кнопки 26px mono, активная — заливка gold текст bg0.
// Совместима с MUI Pagination-логикой на страницах (page 1-based, count = всего
// страниц). base.css:409-419
export interface PagerProps {
  /** Текущая страница (1-based). */
  page: number
  /** Всего страниц. */
  count: number
  /** Смена страницы. */
  onChange: (page: number) => void
  /** Число соседних страниц вокруг текущей (default 1). */
  siblingCount?: number
  sx?: SxProps<Theme>
}

type PagerItem = number | 'gap-l' | 'gap-r'

function buildItems(page: number, count: number, sibling: number): PagerItem[] {
  const items: PagerItem[] = [1]
  const start = Math.max(2, page - sibling)
  const end = Math.min(count - 1, page + sibling)
  if (start > 2) items.push('gap-l')
  for (let i = start; i <= end; i++) items.push(i)
  if (end < count - 1) items.push('gap-r')
  if (count > 1) items.push(count)
  return items
}

const btnBase = {
  minWidth: 26,
  height: 26,
  padding: '0 7px',
  display: 'inline-grid',
  placeItems: 'center',
  fontFamily: tokens.fontMono,
  fontSize: fs.f115,
  fontVariantNumeric: 'tabular-nums',
  color: tokens.text1,
  border: `1px solid ${tokens.border}`,
  borderRadius: 1,
  transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
  '&:hover': { color: tokens.text0, borderColor: tokens.borderHi, background: tokens.bg2 },
  '&.Mui-disabled': {
    opacity: 0.35,
    color: tokens.text2,
    background: 'transparent',
    borderColor: tokens.border,
  },
} as const

export default function Pager({ page, count, onChange, siblingCount = 1, sx }: PagerProps) {
  if (count <= 1) return null
  const items = buildItems(page, count, siblingCount)

  return (
    <Box
      component="nav"
      aria-label="Пагинация"
      sx={[
        {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '3px',
          padding: '12px 16px 14px',
          flexWrap: 'wrap',
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      <ButtonBase
        type="button"
        disableRipple
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        aria-label="Предыдущая страница"
        sx={btnBase}
      >
        ‹
      </ButtonBase>

      {items.map((it) =>
        it === 'gap-l' || it === 'gap-r' ? (
          <Box
            key={it}
            component="span"
            className="mono"
            aria-hidden="true"
            sx={{ minWidth: 22, textAlign: 'center', fontSize: fs.f115, color: tokens.text2 }}
          >
            …
          </Box>
        ) : (
          <ButtonBase
            key={it}
            type="button"
            disableRipple
            onClick={() => onChange(it)}
            aria-label={`Страница ${it}`}
            aria-current={it === page ? 'page' : undefined}
            sx={[
              btnBase,
              it === page && {
                color: tokens.bg0,
                background: tokens.gold,
                borderColor: tokens.gold,
                fontWeight: 700,
                '&:hover': { color: tokens.bg0, background: tokens.gold, borderColor: tokens.gold },
              },
            ]}
          >
            {it}
          </ButtonBase>
        ),
      )}

      <ButtonBase
        type="button"
        disableRipple
        disabled={page >= count}
        onClick={() => onChange(page + 1)}
        aria-label="Следующая страница"
        sx={btnBase}
      >
        ›
      </ButtonBase>
    </Box>
  )
}

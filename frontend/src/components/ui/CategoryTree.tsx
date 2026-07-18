import { useState, Fragment } from 'react'
import { Box, ButtonBase, SxProps, Theme } from '@mui/material'
import { tokens, fs } from '../../theme'
import { CATEGORY_TREE } from '../../utils/categories'

// .side + .cattree + .ct-item — дерево категорий для Каталога и Лотов: ОДИН
// компонент, одна ширина 272px (256 при <1360px). Словари — из
// utils/categories.ts (дубль запрещён). base.css:299-303, 356-377
export interface CategoryTreeProps {
  /** Выбранная категория (null = «Все предметы»). */
  selected: string | null
  /** Смена выбранной категории. */
  onSelect: (id: string | null) => void
  /** Опциональные счётчики по id категории (ключ '' — «Все предметы»). */
  counts?: Record<string, number>
  /** Заголовок сайдбара. */
  title?: string
  /** aria-label для aside. */
  ariaLabel?: string
  sx?: SxProps<Theme>
}

const Chevron = () => (
  <Box
    component="svg"
    width="9"
    height="6"
    viewBox="0 0 9 6"
    fill="none"
    aria-hidden="true"
    sx={{ flex: 'none' }}
  >
    <path d="m1 1 3.5 3.5L8 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </Box>
)

export default function CategoryTree({
  selected,
  onSelect,
  counts,
  title = 'Категории',
  ariaLabel = 'Категории',
  sx,
}: CategoryTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const renderItem = (
    id: string | null,
    label: string,
    opts: { hasChildren?: boolean; open?: boolean; child?: boolean } = {},
  ) => {
    const on = selected === id
    const count = counts?.[id ?? '']
    return (
      <ButtonBase
        type="button"
        disableRipple
        onClick={() => {
          if (opts.hasChildren && id != null) toggle(id)
          onSelect(id)
        }}
        aria-current={on ? 'true' : undefined}
        aria-expanded={opts.hasChildren ? !!opts.open : undefined}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '7px',
          width: '100%',
          padding: opts.child ? '6px 8px 6px 26px' : '6px 8px',
          textAlign: 'left',
          fontSize: opts.child ? fs.f12 : fs.f125,
          borderLeft: '2px solid transparent',
          borderRadius: 1,
          color: on ? tokens.goldAccent : tokens.text1,
          background: on ? tokens.goldDim : 'transparent',
          borderLeftColor: on ? tokens.goldHighlight : 'transparent',
          transition: `color ${tokens.motion.fast}ms ${tokens.motion.ease}, background-color ${tokens.motion.fast}ms ${tokens.motion.ease}, border-color ${tokens.motion.fast}ms ${tokens.motion.ease}`,
          '&:hover': on
            ? { background: tokens.goldDim, color: tokens.goldAccent }
            : { background: tokens.bg2, color: tokens.text0 },
          '&:active': { background: tokens.bg3 },
        }}
      >
        <Box
          component="span"
          sx={{
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {label}
        </Box>
        {count != null && (
          <Box
            component="span"
            className="mono"
            sx={{ fontSize: fs.f105, color: on ? tokens.goldAccent : tokens.text2 }}
          >
            {count.toLocaleString('ru-RU')}
          </Box>
        )}
        {opts.hasChildren && (
          <Box
            component="span"
            sx={{
              display: 'flex',
              color: tokens.text2,
              transition: `transform ${tokens.motion.fast}ms ${tokens.motion.ease}`,
              transform: opts.open ? 'rotate(180deg)' : 'none',
            }}
          >
            <Chevron />
          </Box>
        )}
      </ButtonBase>
    )
  }

  return (
    <Box
      component="aside"
      aria-label={ariaLabel}
      sx={[
        {
          position: 'sticky',
          top: 'var(--sc-top-offset, 156px)',
          maxHeight: 'calc(100vh - var(--sc-top-offset, 156px) - 16px)',
          background: tokens.bg1,
          border: `1px solid ${tokens.border}`,
          borderRadius: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {/* .side-h */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          padding: '10px 12px',
          borderBottom: `1px solid ${tokens.border}`,
        }}
      >
        <Box
          component="h2"
          sx={{
            margin: 0,
            fontFamily: tokens.fontHead,
            fontWeight: 700,
            fontSize: fs.f12,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: tokens.text1,
          }}
        >
          {title}
        </Box>
        {counts?.[''] != null && (
          <Box
            component="span"
            className="mono"
            sx={{ fontSize: fs.f12, color: tokens.goldAccent }}
          >
            {counts[''].toLocaleString('ru-RU')}
          </Box>
        )}
      </Box>

      {/* .cattree */}
      <Box
        sx={{
          overflowY: 'auto',
          padding: '6px 6px 10px',
          display: 'flex',
          flexDirection: 'column',
          scrollbarWidth: 'thin',
          scrollbarColor: `${tokens.goldSoft} transparent`,
        }}
      >
        {CATEGORY_TREE.map((group, idx) => {
          // Индекс 0 — «Все предметы» (id=null); после него — разделитель.
          if (group.id === null) {
            return (
              <Fragment key="__all__">
                {renderItem(null, group.label)}
                <Box
                  aria-hidden="true"
                  sx={{ height: '1px', background: tokens.border, margin: '4px 2px', flex: 'none' }}
                />
              </Fragment>
            )
          }
          const hasChildren = !!group.children?.length
          const open = expanded.has(group.id)
          return (
            <Fragment key={group.id ?? idx}>
              {renderItem(group.id, group.label, { hasChildren, open })}
              {hasChildren && open && (
                <Box sx={{ display: 'flex', flexDirection: 'column' }}>
                  {group.children!.map((child) =>
                    <Fragment key={child.id}>
                      {renderItem(child.id, child.label, { child: true })}
                    </Fragment>,
                  )}
                </Box>
              )}
            </Fragment>
          )
        })}
      </Box>
    </Box>
  )
}

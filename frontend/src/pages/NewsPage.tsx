import { useState, useEffect, useRef } from 'react'
import {
  Box, Typography, Card, Chip, CircularProgress, Alert,
  TextField, Switch, FormControlLabel, Button,
  Select, MenuItem, Checkbox, ListItemText, OutlinedInput,
  InputLabel, FormControl,
} from '@mui/material'
import api from '../api/client'
import { useAuthStore } from '../store/authStore'
import ArmDeleteButton from '../components/ui/ArmDeleteButton'

const G2 = '#D9AF37'
const BG2 = '#1A1F26'
const T0 = '#F5F5F5'
const T1 = '#B8B8B8'
const T2 = '#7C7C7C'
const BORDER = 'rgba(255,255,255,0.08)'

const LIMIT = 20
const TAG_OPTIONS = ['обновление', 'тарифы', 'техработы', 'важно'] as const

interface NewsItem {
  id: number
  author_id: number | null
  author_username: string | null
  title: string
  content: string
  tags: string[]
  is_pinned: boolean
  is_published: boolean
  created_at: string
  updated_at: string | null
}

interface FormState {
  title: string
  content: string
  tags: string[]
  is_pinned: boolean
  is_published: boolean
}

const EMPTY_FORM: FormState = {
  title: '',
  content: '',
  tags: [],
  is_pinned: false,
  is_published: true,
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function isEditedSignificantly(created: string, updated: string | null): boolean {
  if (!updated) return false
  const diff = Math.abs(new Date(updated).getTime() - new Date(created).getTime())
  return diff > 60_000
}

// ─── NewsCard ────────────────────────────────────────────────────────────────

interface NewsCardProps {
  item: NewsItem
  isAdmin: boolean
  onEdit: (item: NewsItem) => void
  onDelete: (id: number) => void
}

function NewsCard({ item, isAdmin, onEdit, onDelete }: NewsCardProps) {
  const showEdited = isEditedSignificantly(item.created_at, item.updated_at)

  return (
    <Card sx={{
      bgcolor: BG2,
      border: item.is_pinned
        ? `2px solid ${G2}`
        : `1px solid ${BORDER}`,
      borderRadius: '12px',
      overflow: 'hidden',
      position: 'relative',
      ...(item.is_pinned ? {} : {}),
    }}>
      {/* Верхняя полоска для закреплённых */}
      {item.is_pinned && (
        <Box sx={{
          height: 2,
          background: `linear-gradient(90deg, #B78A2A 0%, ${G2} 50%, #F2C94C 100%)`,
        }} />
      )}

      <Box sx={{ p: 2 }}>
        {/* Строка: чип ЗАКРЕПЛЕНО + теги + кнопки admin */}
        <Box sx={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, flex: 1, minWidth: 0 }}>
            {item.is_pinned && (
              <Chip
                label="ЗАКРЕПЛЕНО"
                size="small"
                sx={{
                  height: 18, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                  bgcolor: 'rgba(217,175,55,0.15)',
                  color: G2,
                  border: `1px solid rgba(217,175,55,0.35)`,
                }}
              />
            )}
            {item.tags.map((tag) => (
              <Chip
                key={tag}
                label={tag}
                size="small"
                sx={{
                  height: 18, fontSize: 9,
                  bgcolor: 'rgba(255,255,255,0.06)',
                  color: T2,
                  border: `1px solid ${BORDER}`,
                }}
              />
            ))}
            {!item.is_published && (
              <Chip
                label="ЧЕРНОВИК"
                size="small"
                sx={{
                  height: 18, fontSize: 9, fontWeight: 700,
                  bgcolor: 'rgba(255,90,90,0.1)',
                  color: '#FF5A5A',
                  border: '1px solid rgba(255,90,90,0.3)',
                }}
              />
            )}
          </Box>

          {/* Admin-кнопки */}
          {isAdmin && (
            <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
              <Button
                size="small"
                onClick={() => onEdit(item)}
                sx={{
                  fontSize: '0.68rem', py: 0.2, px: 1, minWidth: 0,
                  color: T2,
                  border: `1px solid ${BORDER}`,
                  borderRadius: '6px',
                  '&:hover': { color: G2, borderColor: 'rgba(217,175,55,0.4)' },
                }}
              >
                Редактировать
              </Button>
              <ArmDeleteButton
                onConfirm={() => onDelete(item.id)}
                armedLabel="Точно удалить?"
                aria-label={`Удалить новость «${item.title}»`}
              />
            </Box>
          )}
        </Box>

        {/* Заголовок */}
        <Typography sx={{
          fontFamily: '"Rajdhani", sans-serif',
          fontWeight: 700,
          fontSize: '1.1rem',
          color: T0,
          lineHeight: 1.3,
          mb: 0.75,
        }}>
          {item.title}
        </Typography>

        {/* Контент */}
        <Typography sx={{
          fontSize: '0.88rem',
          color: T1,
          lineHeight: 1.65,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {item.content}
        </Typography>

        {/* Подвал: автор + дата */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1.5, flexWrap: 'wrap', gap: 0.5 }}>
          <Typography sx={{ fontSize: '0.72rem', color: T2 }}>
            {item.author_username ?? 'Администратор'}
          </Typography>
          <Typography sx={{ fontSize: '0.72rem', color: T2 }}>
            {formatDate(item.created_at)}
            {showEdited && ` (ред. ${formatDate(item.updated_at!)})`}
          </Typography>
        </Box>
      </Box>
    </Card>
  )
}

// ─── NewsForm ─────────────────────────────────────────────────────────────────

interface NewsFormProps {
  initial?: NewsItem | null
  onSaved: (item: NewsItem) => void
  onCancel: () => void
}

function NewsForm({ initial, onSaved, onCancel }: NewsFormProps) {
  const [form, setForm] = useState<FormState>(
    initial
      ? {
          title: initial.title,
          content: initial.content,
          tags: initial.tags,
          is_pinned: initial.is_pinned,
          is_published: initial.is_published,
        }
      : { ...EMPTY_FORM }
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    if (!form.title.trim()) { setError('Заголовок не может быть пустым'); return }
    if (!form.content.trim()) { setError('Содержание не может быть пустым'); return }
    setSaving(true)
    setError(null)
    try {
      const payload = {
        title: form.title.trim(),
        content: form.content.trim(),
        tags: form.tags,
        is_pinned: form.is_pinned,
        is_published: form.is_published,
      }
      const { data } = initial
        ? await api.put<NewsItem>(`/news/${initial.id}`, payload)
        : await api.post<NewsItem>('/news/', payload)
      onSaved(data)
    } catch {
      setError('Не удалось сохранить. Попробуйте ещё раз.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card sx={{
      bgcolor: BG2,
      border: `1px solid rgba(217,175,55,0.25)`,
      borderRadius: '12px',
      p: 2.5,
      mb: 2,
    }}>
      <Typography sx={{
        fontFamily: '"Rajdhani", sans-serif',
        fontWeight: 700,
        fontSize: '0.95rem',
        color: G2,
        letterSpacing: '0.06em',
        mb: 2,
      }}>
        {initial ? 'РЕДАКТИРОВАТЬ НОВОСТЬ' : 'НОВАЯ НОВОСТЬ'}
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2, fontSize: '0.82rem' }}>{error}</Alert>
      )}

      <TextField
        fullWidth
        label="Заголовок"
        value={form.title}
        onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
        inputProps={{ maxLength: 300 }}
        sx={{ mb: 2 }}
        size="small"
      />

      <TextField
        fullWidth
        label="Содержание"
        multiline
        rows={5}
        value={form.content}
        onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
        sx={{ mb: 2 }}
        size="small"
      />

      {/* Мультиселект тегов */}
      <FormControl fullWidth size="small" sx={{ mb: 2 }}>
        <InputLabel>Теги</InputLabel>
        <Select
          multiple
          value={form.tags}
          onChange={(e) => {
            const val = e.target.value
            setForm((f) => ({ ...f, tags: typeof val === 'string' ? val.split(',') : val }))
          }}
          input={<OutlinedInput label="Теги" />}
          renderValue={(selected) => selected.join(', ')}
        >
          {TAG_OPTIONS.map((tag) => (
            <MenuItem key={tag} value={tag}>
              <Checkbox checked={form.tags.includes(tag)} size="small" />
              <ListItemText primary={tag} primaryTypographyProps={{ fontSize: '0.88rem' }} />
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Box sx={{ display: 'flex', gap: 3, mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={form.is_pinned}
              onChange={(e) => setForm((f) => ({ ...f, is_pinned: e.target.checked }))}
              size="small"
              sx={{ '& .MuiSwitch-thumb': { bgcolor: form.is_pinned ? G2 : undefined } }}
            />
          }
          label={<Typography sx={{ fontSize: '0.82rem', color: T1 }}>Закрепить</Typography>}
        />
        <FormControlLabel
          control={
            <Switch
              checked={form.is_published}
              onChange={(e) => setForm((f) => ({ ...f, is_published: e.target.checked }))}
              size="small"
            />
          }
          label={<Typography sx={{ fontSize: '0.82rem', color: T1 }}>Опубликовать</Typography>}
        />
      </Box>

      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={saving}
          sx={{
            bgcolor: G2, color: '#080808', fontWeight: 700,
            fontFamily: '"Rajdhani", sans-serif',
            fontSize: '0.82rem', letterSpacing: '0.06em',
            '&:hover': { bgcolor: '#F2C94C' },
            '&.Mui-disabled': { bgcolor: 'rgba(217,175,55,0.3)', color: 'rgba(0,0,0,0.4)' },
          }}
        >
          {saving ? <CircularProgress size={16} sx={{ color: '#080808' }} /> : 'Сохранить'}
        </Button>
        <Button
          variant="text"
          onClick={onCancel}
          disabled={saving}
          sx={{ fontSize: '0.82rem', color: T2, '&:hover': { color: T1 } }}
        >
          Отмена
        </Button>
      </Box>
    </Card>
  )
}

// ─── NewsPage ─────────────────────────────────────────────────────────────────

export default function NewsPage() {
  const user = useAuthStore((s) => s.user)
  const isAdmin = !!user?.is_admin

  const [news, setNews] = useState<NewsItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [skip, setSkip] = useState(0)

  const [showForm, setShowForm] = useState(false)
  const [editTarget, setEditTarget] = useState<NewsItem | null>(null)
  const [showDrafts, setShowDrafts] = useState(false)

  const formRef = useRef<HTMLDivElement>(null)

  // ── Загрузка ─────────────────────────────────────────────────────────────

  async function loadNews(skipVal: number, append: boolean) {
    try {
      const endpoint = isAdmin && showDrafts ? '/news/admin/all' : '/news/'
      const { data } = await api.get<NewsItem[]>(endpoint, {
        params: { skip: skipVal, limit: LIMIT },
      })
      setNews((prev) => append ? [...prev, ...data] : data)
      setHasMore(data.length === LIMIT)
      setSkip(skipVal + data.length)
    } catch {
      if (!append) setError(true)
    }
  }

  useEffect(() => {
    setLoading(true)
    setError(false)
    loadNews(0, false).finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDrafts])

  async function handleLoadMore() {
    setLoadingMore(true)
    await loadNews(skip, true)
    setLoadingMore(false)
  }

  // ── Действия формы ────────────────────────────────────────────────────────

  function openCreate() {
    setEditTarget(null)
    setShowForm(true)
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  function openEdit(item: NewsItem) {
    setEditTarget(item)
    setShowForm(true)
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  function handleSaved(saved: NewsItem) {
    if (editTarget) {
      setNews((prev) => prev.map((n) => n.id === saved.id ? saved : n))
    } else {
      setNews((prev) => [saved, ...prev])
    }
    setShowForm(false)
    setEditTarget(null)
  }

  async function handleDelete(id: number) {
    try {
      await api.delete(`/news/${id}`)
      setNews((prev) => prev.filter((n) => n.id !== id))
    } catch {
      // можно показать snackbar, пока молча
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (error) {
    return (
      <Box sx={{ textAlign: 'center', mt: 8 }}>
        <Typography variant="h6" color="text.secondary">Не удалось загрузить новости</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Попробуйте обновить страницу позже.
        </Typography>
      </Box>
    )
  }

  return (
    <Box>
      {/* Заголовок */}
      <Box sx={{ mb: 2.5, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Box>
          <Typography sx={{
            fontSize: '0.6rem', color: 'text.disabled',
            letterSpacing: '0.14em', fontWeight: 600, lineHeight: 1, mb: 0.4,
          }}>
            НОВОСТИ
          </Typography>
          <Typography variant="h5" fontWeight={700}>
            Объявления и обновления
          </Typography>
        </Box>

        {isAdmin && (
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              size="small"
              onClick={() => setShowDrafts((v) => !v)}
              sx={{
                fontSize: '0.72rem', color: showDrafts ? G2 : T2,
                border: `1px solid ${showDrafts ? 'rgba(217,175,55,0.4)' : BORDER}`,
                borderRadius: '8px', px: 1.5,
                '&:hover': { borderColor: 'rgba(217,175,55,0.4)', color: G2 },
              }}
            >
              {showDrafts ? 'Скрыть черновики' : 'Показать черновики'}
            </Button>
            <Button
              size="small"
              onClick={openCreate}
              sx={{
                fontSize: '0.72rem', fontWeight: 700,
                bgcolor: 'rgba(217,175,55,0.12)',
                color: G2,
                border: `1px solid rgba(217,175,55,0.35)`,
                borderRadius: '8px', px: 1.5,
                '&:hover': { bgcolor: 'rgba(217,175,55,0.2)' },
              }}
            >
              + Новость
            </Button>
          </Box>
        )}
      </Box>

      {/* Форма создания/редактирования */}
      <div ref={formRef}>
        {showForm && (
          <NewsForm
            initial={editTarget}
            onSaved={handleSaved}
            onCancel={() => { setShowForm(false); setEditTarget(null) }}
          />
        )}
      </div>

      {/* Список */}
      {news.length === 0 ? (
        <Box sx={{ textAlign: 'center', mt: 8 }}>
          <Typography variant="h6" color="text.secondary">Новостей пока нет</Typography>
          {isAdmin && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Создайте первую новость с помощью кнопки «+ Новость».
            </Typography>
          )}
        </Box>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {news.map((item) => (
            <NewsCard
              key={item.id}
              item={item}
              isAdmin={isAdmin}
              onEdit={openEdit}
              onDelete={handleDelete}
            />
          ))}
        </Box>
      )}

      {/* Кнопка «Загрузить ещё» */}
      {hasMore && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
          <Button
            onClick={handleLoadMore}
            disabled={loadingMore}
            sx={{
              color: T2, border: `1px solid ${BORDER}`, borderRadius: '8px',
              fontSize: '0.8rem', px: 3,
              '&:hover': { color: T1, borderColor: 'rgba(255,255,255,0.2)' },
            }}
          >
            {loadingMore ? <CircularProgress size={16} sx={{ color: T2 }} /> : 'Загрузить ещё'}
          </Button>
        </Box>
      )}
    </Box>
  )
}

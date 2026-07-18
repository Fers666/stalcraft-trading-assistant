import { QUALITY_COLORS } from '../theme'

/** Перевод категорий предметов с английского на русский */
const CATEGORY_MAP: Record<string, string> = {
  // Топ-уровень
  weapon:          'Оружие',
  armor:           'Броня',
  artefact:        'Артефакт',
  attachment:      'Обвес',
  bullet:          'Патроны',
  medicine:        'Медицина',
  supply:          'Расходники',
  food:            'Еда',
  drink:           'Напитки',
  grenade:         'Гранаты',
  containers:      'Контейнеры',
  backpacks:       'Рюкзаки',
  misc:            'Разное',
  other:           'Прочее',
  device:          'Устройство',
  weapon_modules:  'Модули оружия',
  // Оружие
  assault_rifle:   'Штурмовая винтовка',
  sniper_rifle:    'Снайперская винтовка',
  pistol:          'Пистолет',
  shotgun_rifle:   'Дробовик',
  submachine_gun:  'Пистолет-пулемёт',
  machine_gun:     'Пулемёт',
  melee:           'Холодное оружие',
  heavy:           'Тяжёлое',
  // Броня
  combat:          'Боевая',
  light:           'Лёгкая',
  clothes:         'Одежда',
  combined:        'Комбинированная',
  scientist:       'Учёного',
  // Артефакты
  biochemical:     'Биохимический',
  thermal:         'Термический',
  gravity:         'Гравитационный',
  electrophysical: 'Электрофизический',
  other_arts:      'Прочие',
  // Обвесы
  collimator_sights: 'Коллиматор',
  barrel:          'Ствол',
  mag:             'Магазин',
  forend:          'Цевьё',
  handgrips:       'Рукоять',
  accessory:       'Аксессуар',
  pistol_handle:   'Пист. рукоять',
  // Модули
  weapon_module:         'Оружейный модуль',
  weapon_module_core:    'Ядро модуля',
  weapon_module_remover: 'Квазидеструктор',
  // Прочие подкатегории
  armor_motif: 'Мотив брони',
  skins:       'Скины',
}

/** Переводит категорию вида "artefact/biochemical" → "Артефакт / Биохимический" */
export function translateCategory(category: string | null): string {
  if (!category) return '—'
  return category
    .split('/')
    .map((part) => CATEGORY_MAP[part] ?? part)
    .join(' / ')
}

/** Форматирует число как цену в рублях */
export function formatPrice(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString('ru-RU') + ' ₽'
}

// ─── Единая шкала качества (COL-01) ──────────────────────────────────────────
// Ключи — из QUALITY_COLORS (theme.ts). Цвета нигде не хардкодятся: имя качества
// / DB-color / числовой уровень нормализуются к одному ключу.

/** Русское имя качества → ключ QUALITY_COLORS */
const QUALITY_KEY_BY_NAME: Record<string, string> = {
  'Обычный': 'default', 'Необычный': 'newbie', 'Особый': 'stalker',
  'Ветеран': 'veteran', 'Мастер': 'master', 'Легендарный': 'legend',
}

/** Числовой уровень качества (0–5) → ключ QUALITY_COLORS */
const QUALITY_KEY_BY_VALUE = ['default', 'newbie', 'stalker', 'veteran', 'master', 'legend']

/** Поле `color` предмета из БД → ключ QUALITY_COLORS */
export function qualityKeyFromColor(color: string | null | undefined): string {
  if (!color) return 'default'
  const c = color.toLowerCase()
  const map: Record<string, string> = {
    default: 'default',
    rank_newbie: 'newbie', rank_stalker: 'stalker', rank_veteran: 'veteran',
    rank_master: 'master', rank_legend: 'legend',
    // легаси-алиасы цветовых имён
    gray: 'default', grey: 'default', white: 'default',
    green: 'newbie', blue: 'stalker', violet: 'veteran', purple: 'veteran',
    yellow: 'master', black: 'master', red: 'legend', quest_item: 'legend',
  }
  return map[c] ?? 'default'
}

/** Числовой уровень качества (0–5) → ключ QUALITY_COLORS */
export function qualityKeyByValue(value: number | null | undefined): string {
  if (value == null) return 'default'
  return QUALITY_KEY_BY_VALUE[value] ?? 'default'
}

/** Цвет по названию качества предмета (Обычный/Необычный/.../Легендарный) */
export function qualityColor(quality: string | null): string | null {
  if (!quality) return null
  const key = QUALITY_KEY_BY_NAME[quality]
  return key ? QUALITY_COLORS[key] : null
}

/** Форматирует ISO-дату как "HH:MM" (сегодня), "вчера, HH:MM" или "DD.MM, HH:MM" */
export function formatLastUpdate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null

  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDate  = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86400000)

  if (diffDays === 0) return time
  if (diffDays === 1) return `вчера, ${time}`
  return `${date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}, ${time}`
}

const ICON_BASE = 'https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru'

/** Возвращает полный URL иконки предмета */
export function iconUrl(iconPath: string | null | undefined): string | null {
  if (!iconPath) return null
  return `${ICON_BASE}${iconPath}`
}

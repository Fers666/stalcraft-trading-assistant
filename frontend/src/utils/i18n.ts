/** Перевод категорий предметов с английского на русский */
const CATEGORY_MAP: Record<string, string> = {
  weapon:          'Оружие',
  armor:           'Броня',
  artefact:        'Артефакт',
  attachment:      'Обвес',
  bullet:          'Патроны',
  medicine:        'Медицина',
  food:            'Еда',
  drink:           'Напитки',
  grenade:         'Гранаты',
  containers:      'Контейнеры',
  backpacks:       'Рюкзаки',
  misc:            'Разное',
  other:           'Прочее',
  weapon_modules:  'Модули оружия',
  // Подкатегории
  assault_rifle:   'Штурмовая винтовка',
  sniper_rifle:    'Снайперская винтовка',
  pistol:          'Пистолет',
  shotgun:         'Дробовик',
  smg:             'Пистолет-пулемёт',
  lmg:             'Пулемёт',
  melee:           'Холодное оружие',
  combat:          'Боевая',
  light:           'Лёгкая',
  heavy:           'Тяжёлая',
  biochemical:     'Биохимический',
  thermal:         'Термический',
  gravitational:   'Гравитационный',
  electrical:      'Электрический',
  collimator_sights: 'Коллиматорный прицел',
  barrel:          'Ствол',
  mag:             'Магазин',
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
  return n.toLocaleString('ru-RU') + ' ₽'
}

const ICON_BASE = 'https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru'

/** Возвращает полный URL иконки предмета */
export function iconUrl(iconPath: string | null | undefined): string | null {
  if (!iconPath) return null
  return `${ICON_BASE}${iconPath}`
}

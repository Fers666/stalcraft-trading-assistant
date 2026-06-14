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

const ICON_BASE = 'https://raw.githubusercontent.com/EXBO-Studio/stalcraft-database/main/ru'

/** Возвращает полный URL иконки предмета */
export function iconUrl(iconPath: string | null | undefined): string | null {
  if (!iconPath) return null
  return `${ICON_BASE}${iconPath}`
}

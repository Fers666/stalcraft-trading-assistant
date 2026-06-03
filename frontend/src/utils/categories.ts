export interface CategoryLeaf {
  id: string
  label: string
}

export interface CategoryGroup {
  id: string | null
  label: string
  children?: CategoryLeaf[]
}

export const CATEGORY_TREE: CategoryGroup[] = [
  { id: null, label: 'Все предметы' },
  {
    id: 'weapon',
    label: 'Оружие',
    children: [
      { id: 'weapon/assault_rifle',  label: 'Штурмовые винтовки' },
      { id: 'weapon/sniper_rifle',   label: 'Снайперские винтовки' },
      { id: 'weapon/pistol',         label: 'Пистолеты' },
      { id: 'weapon/shotgun_rifle',  label: 'Дробовики' },
      { id: 'weapon/submachine_gun', label: 'Пистолеты-пулемёты' },
      { id: 'weapon/machine_gun',    label: 'Пулемёты' },
      { id: 'weapon/melee',          label: 'Холодное оружие' },
      { id: 'weapon/heavy',          label: 'Тяжёлое' },
    ],
  },
  {
    id: 'armor',
    label: 'Броня',
    children: [
      { id: 'armor/combat',    label: 'Боевая' },
      { id: 'armor/light',     label: 'Лёгкая' },
      { id: 'armor/heavy',     label: 'Тяжёлая' },
      { id: 'armor/clothes',   label: 'Одежда' },
      { id: 'armor/combined',  label: 'Комбинированная' },
      { id: 'armor/scientist', label: 'Учёного' },
    ],
  },
  {
    id: 'artefact',
    label: 'Артефакты',
    children: [
      { id: 'artefact/biochemical',     label: 'Биохимические' },
      { id: 'artefact/thermal',         label: 'Термические' },
      { id: 'artefact/gravity',         label: 'Гравитационные' },
      { id: 'artefact/electrophysical', label: 'Электрофизические' },
      { id: 'artefact/other_arts',      label: 'Прочие' },
    ],
  },
  {
    id: 'attachment',
    label: 'Обвесы',
    children: [
      { id: 'attachment/collimator_sights', label: 'Коллиматоры' },
      { id: 'attachment/barrel',            label: 'Стволы' },
      { id: 'attachment/mag',               label: 'Магазины' },
      { id: 'attachment/forend',            label: 'Цевья' },
      { id: 'attachment/handgrips',         label: 'Рукояти' },
      { id: 'attachment/accessory',         label: 'Аксессуары' },
      { id: 'attachment/pistol_handle',     label: 'Пист. рукоять' },
      { id: 'attachment/other',             label: 'Прочее' },
    ],
  },
  { id: 'weapon_modules',  label: 'Модули оружия' },
  { id: 'bullet',          label: 'Патроны' },
  { id: 'supply/medicine', label: 'Медикаменты' },
  { id: 'medicine',        label: 'Подсумки' },
  { id: 'supply/food',     label: 'Еда' },
  { id: 'supply/drink',    label: 'Напитки' },
  { id: 'grenade',         label: 'Гранаты' },
  { id: 'containers',      label: 'Контейнеры' },
  { id: 'backpacks',       label: 'Рюкзаки' },
  { id: 'device',          label: 'Устройства' },
  { id: 'misc',            label: 'Разное' },
  { id: 'other',           label: 'Прочее' },
]

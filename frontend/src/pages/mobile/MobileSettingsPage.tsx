import SettingsPage from '../SettingsPage'

// Настройки (мобайл). Десктопный SettingsPage уже адаптивен: сетка панелей
// `.setcols` сворачивается в одну колонку на узком экране ({ xs: '1fr', md:
// '1fr 1fr' }), инпуты ограничены maxWidth, широких таблиц нет → без
// горизонтального скролла. Обёртка — точка мобильного роута ModeSwitch.
export default function MobileSettingsPage() {
  return <SettingsPage />
}

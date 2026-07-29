import { useLayoutMode } from '../hooks/useLayoutMode'

// Выбор элемента по эффективному режиму раскладки. Точка переключения —
// на уровне роутинга (App.tsx): оболочка и каждая страница.
export default function ModeSwitch({
  desktop,
  mobile,
}: {
  desktop: React.ReactNode
  mobile: React.ReactNode
}) {
  const { mode } = useLayoutMode()
  return <>{mode === 'mobile' ? mobile : desktop}</>
}

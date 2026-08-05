import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import Layout from './components/Layout'
import ModeSwitch from './components/ModeSwitch'
import MobileLayout from './components/mobile/MobileLayout'
import MobileFavoritesPage from './pages/mobile/MobileFavoritesPage'
import MobileCatalogPage from './pages/mobile/MobileCatalogPage'
import MobileLotsPage from './pages/mobile/MobileLotsPage'
import MobileFeedPage from './pages/mobile/MobileFeedPage'
import MobileBuySniperPage from './pages/mobile/MobileBuySniperPage'
import MobileNewsPage from './pages/mobile/MobileNewsPage'
import MobileMarketRadarPage from './pages/mobile/MobileMarketRadarPage'
import MobileSettingsPage from './pages/mobile/MobileSettingsPage'
import MobileAdminPage from './pages/mobile/MobileAdminPage'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import FaqPage from './pages/FaqPage'
import MonitoringPage from './pages/MonitoringPage'
import CatalogPage from './pages/CatalogPage'
import LotsPage from './pages/LotsPage'
import FeedPage from './pages/FeedPage'
import BuySniperPage from './pages/BuySniperPage'
import SettingsPage from './pages/SettingsPage'
import AdminPage from './pages/AdminPage'
import MarketRadarPage from './pages/MarketRadarPage'
import NewsPage from './pages/NewsPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('access_token')
  if (!token) return <Navigate to="/" replace />
  return <>{children}</>
}

function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('access_token')
  if (token) return <Navigate to="/app/monitoring" replace />
  return <>{children}</>
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const token = localStorage.getItem('access_token')
  if (!token) return <Navigate to="/" replace />
  if (!user) return null                              // fetchMe ещё не вернул
  if (!user.is_admin) return <Navigate to="/app/monitoring" replace />
  return <>{children}</>
}

export default function App() {
  const fetchMe = useAuthStore((s) => s.fetchMe)

  useEffect(() => {
    fetchMe()
  }, [fetchMe])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login"    element={<PublicOnlyRoute><LoginPage /></PublicOnlyRoute>} />
        <Route path="/register" element={<PublicOnlyRoute><RegisterPage /></PublicOnlyRoute>} />
        <Route path="/faq"      element={<FaqPage />} />

        <Route
          path="/app"
          element={<ProtectedRoute><ModeSwitch desktop={<Layout />} mobile={<MobileLayout />} /></ProtectedRoute>}
        >
          <Route index                element={<Navigate to="/app/monitoring" replace />} />
          <Route path="monitoring"     element={<ModeSwitch desktop={<MonitoringPage />}   mobile={<MobileFavoritesPage />} />} />
          <Route path="catalog"       element={<ModeSwitch desktop={<CatalogPage />}      mobile={<MobileCatalogPage />} />} />
          <Route path="lots"          element={<ModeSwitch desktop={<LotsPage />}         mobile={<MobileLotsPage />} />} />
          <Route path="feed"          element={<ModeSwitch desktop={<FeedPage />}          mobile={<MobileFeedPage />} />} />
          <Route path="buy-sniper"    element={<ModeSwitch desktop={<BuySniperPage />}    mobile={<MobileBuySniperPage />} />} />
          <Route path="inventory"     element={<Navigate to="/app/buy-sniper" replace />} />
          <Route path="news"          element={<ModeSwitch desktop={<NewsPage />}         mobile={<MobileNewsPage />} />} />
          <Route path="market-radar"  element={<ModeSwitch desktop={<MarketRadarPage />}  mobile={<MobileMarketRadarPage />} />} />
          <Route path="settings"      element={<ModeSwitch desktop={<SettingsPage />}     mobile={<MobileSettingsPage />} />} />
          <Route path="admin"         element={<AdminRoute><ModeSwitch desktop={<AdminPage />} mobile={<MobileAdminPage />} /></AdminRoute>} />
        </Route>

        <Route path="/monitoring" element={<Navigate to="/app/monitoring" replace />} />
        <Route path="/catalog"    element={<Navigate to="/app/catalog" replace />} />
        <Route path="/lots"       element={<Navigate to="/app/lots" replace />} />
        <Route path="/inventory"  element={<Navigate to="/app/buy-sniper" replace />} />
        <Route path="/settings"   element={<Navigate to="/app/settings" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

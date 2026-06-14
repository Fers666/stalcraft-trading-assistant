import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import Layout from './components/Layout'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import MonitoringPage from './pages/MonitoringPage'
import CatalogPage from './pages/CatalogPage'
import LotsPage from './pages/LotsPage'
import FeedPage from './pages/FeedPage'
import InventoryPage from './pages/InventoryPage'
import SettingsPage from './pages/SettingsPage'
import AdminPage from './pages/AdminPage'

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
  if (user && !user.is_admin) return <Navigate to="/app/monitoring" replace />
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

        <Route
          path="/app"
          element={<ProtectedRoute><Layout /></ProtectedRoute>}
        >
          <Route index                element={<Navigate to="/app/monitoring" replace />} />
          <Route path="monitoring"     element={<MonitoringPage />} />
          <Route path="catalog"       element={<CatalogPage />} />
          <Route path="lots"          element={<LotsPage />} />
          <Route path="feed"          element={<FeedPage />} />
          <Route path="inventory"     element={<InventoryPage />} />
          <Route path="settings"      element={<SettingsPage />} />
          <Route path="admin"         element={<AdminRoute><AdminPage /></AdminRoute>} />
        </Route>

        <Route path="/monitoring" element={<Navigate to="/app/monitoring" replace />} />
        <Route path="/catalog"    element={<Navigate to="/app/catalog" replace />} />
        <Route path="/lots"       element={<Navigate to="/app/lots" replace />} />
        <Route path="/inventory"  element={<Navigate to="/app/inventory" replace />} />
        <Route path="/settings"   element={<Navigate to="/app/settings" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

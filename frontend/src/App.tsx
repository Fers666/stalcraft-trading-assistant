import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import MonitoringPage from './pages/MonitoringPage'
import CatalogPage from './pages/CatalogPage'
import LotsPage from './pages/LotsPage'
import InventoryPage from './pages/InventoryPage'
import SettingsPage from './pages/SettingsPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('access_token')
  if (!token) return <Navigate to="/login" replace />
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
        <Route path="/login"    element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index                element={<Navigate to="/monitoring" replace />} />
          <Route path="monitoring"    element={<MonitoringPage />} />
          <Route path="catalog"       element={<CatalogPage />} />
          <Route path="lots"          element={<LotsPage />} />
          <Route path="inventory"     element={<InventoryPage />} />
          <Route path="settings"      element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

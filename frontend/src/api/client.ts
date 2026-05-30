import axios from 'axios'

const api = axios.create({
  baseURL: 'http://localhost:8000/api/v1',
})

// Добавляем JWT токен к каждому запросу
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Обработка 401 — редирект на логин
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('access_token')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

export default api

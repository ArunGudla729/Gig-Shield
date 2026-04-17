import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

// Attach JWT token to every request
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Auto-logout on 401 — only when the failing request carried a token AND
// the request is not a background notifications poll. Notifications polling
// failures (e.g. transient 401 during token refresh) must never log the user
// out — the bell simply shows no data until the next successful poll.
api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      const hasToken = !!localStorage.getItem('token')
      const url = err.config?.url ?? ''
      const isNotificationCall = url.includes('/notifications')

      if (hasToken && !isNotificationCall) {
        localStorage.removeItem('token')
        localStorage.removeItem('is_admin')
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  }
)

export default api

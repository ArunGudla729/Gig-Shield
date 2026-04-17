import { useState, useEffect, useRef } from 'react'
import { Bell } from 'lucide-react'
import api from '../api'

export default function NotificationBell() {
  const [notifications, setNotifications] = useState([])
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef(null)

  const fetchNotifications = async () => {
    try {
      const res = await api.get('/notifications')
      setNotifications(res.data)
    } catch {
      // fail silently — bell should never crash the page
    }
  }

  // Initial fetch + 5-second polling
  useEffect(() => {
    fetchNotifications()
    const interval = setInterval(fetchNotifications, 5000)
    return () => clearInterval(interval)
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const markRead = async (id) => {
    try {
      await api.post(`/notifications/read/${id}`)
      setNotifications(prev =>
        prev.map(n => n.id === id ? { ...n, is_read: true } : n)
      )
    } catch {
      // fail silently
    }
  }

  const handleClearAll = async () => {
    try {
      await api.post('/notifications/read-all')
      // Optimistically mark all as read locally, then sync with server
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })))
      fetchNotifications()
    } catch (err) {
      // Error clearing notifications: err handled silently
    }
  }

  const unreadCount = notifications.filter(n => !n.is_read).length

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(prev => !prev)}
        className="relative p-2 hover:bg-gray-100 rounded-lg transition"
        aria-label="Notifications"
      >
        <Bell size={18} className="text-gray-600" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-lg border border-gray-100 z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">Notifications</span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-400">
                {unreadCount > 0 ? `${unreadCount} unread` : 'All read'}
              </span>
              <button
                onClick={handleClearAll}
                className="text-xs text-blue-500 hover:underline"
              >
                Clear All
              </button>
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
            {notifications.filter(n => !n.is_read).length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-gray-400">
                No notifications
              </div>
            ) : (
              notifications.filter(n => !n.is_read).map(n => (
                <div
                  key={n.id}
                  onClick={() => markRead(n.id)}
                  className="px-4 py-3 cursor-pointer transition bg-blue-50 hover:bg-blue-100"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-1.5 flex-shrink-0 w-2 h-2 bg-blue-500 rounded-full" />
                    <div>
                      <p className="text-sm text-gray-800 leading-snug">{n.message}</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {new Date(
                          n.created_at.endsWith('Z') || n.created_at.includes('+')
                            ? n.created_at
                            : n.created_at + 'Z'
                        ).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                      </p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

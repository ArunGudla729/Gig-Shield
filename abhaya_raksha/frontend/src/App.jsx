import { Routes, Route, Navigate } from 'react-router-dom'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import AdminDashboard from './pages/AdminDashboard'
import AdminLocationPage from './pages/AdminLocationPage'
import Simulation from './pages/Simulation'
import Footer from './components/Footer'

function PrivateRoute({ children }) {
  return localStorage.getItem('token') ? children : <Navigate to="/login" />
}

function AdminRoute({ children }) {
  if (!localStorage.getItem('token')) return <Navigate to="/login" />
  if (localStorage.getItem('is_admin') !== 'true') return <Navigate to="/dashboard" />
  return children
}

export default function App() {
  return (
    <div className="flex flex-col min-h-screen">
      <div className="flex-1">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/dashboard" element={<PrivateRoute><Dashboard /></PrivateRoute>} />
          <Route path="/admin" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
          <Route path="/admin/locations" element={<AdminRoute><AdminLocationPage /></AdminRoute>} />
          <Route path="/simulate" element={<AdminRoute><Simulation /></AdminRoute>} />
        </Routes>
      </div>
      <Footer />
    </div>
  )
}

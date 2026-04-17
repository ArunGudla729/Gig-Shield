import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import api from '../api'
import toast from 'react-hot-toast'
import { Shield } from 'lucide-react'

const CITIES = [
  { name: 'Mumbai', lat: 19.076, lng: 72.877 },
  { name: 'Delhi', lat: 28.613, lng: 77.209 },
  { name: 'Bangalore', lat: 12.972, lng: 77.594 },
  { name: 'Chennai', lat: 13.083, lng: 80.270 },
  { name: 'Hyderabad', lat: 17.385, lng: 78.487 },
  { name: 'Pune', lat: 18.520, lng: 73.856 },
]

export default function Register() {
  const [form, setForm] = useState({
    name: '', email: '', phone: '', password: '',
    worker_type: 'food_delivery', city: 'Mumbai',
    zone: 'Central', lat: 19.076, lng: 72.877,
    avg_daily_income: 800, gender: ''
  })
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showWomenDialog, setShowWomenDialog] = useState(false)
  const navigate = useNavigate()

  // ── KYC placeholder (frontend-only, not sent to backend) ─────────────────
  const [partnerID, setPartnerID] = useState('')
  const [partnerIDError, setPartnerIDError] = useState('')

  const handleCityChange = e => {
    const city = CITIES.find(c => c.name === e.target.value)
    setForm({ ...form, city: city.name, lat: city.lat, lng: city.lng })
  }

  const handleSubmit = async e => {
    e.preventDefault()

    // Validate partner ID format if filled (frontend-only, never sent to backend)
    if (partnerID.trim()) {
      const valid = /^(SWG|ZMT|AMZ|BLK|ZPT)-\d{6}$/i.test(partnerID.trim())
      if (!valid) {
        setPartnerIDError('Format must be SWG-123456, ZMT-987654, AMZ-123456, etc.')
        return
      }
    }
    setPartnerIDError('')

    setLoading(true)
    try {
      // partnerID is intentionally NOT included in the API payload
      await api.post('/auth/register', { ...form, avg_daily_income: Number(form.avg_daily_income), gender: form.gender || undefined })

      // Store verified flag in localStorage for dashboard badge (demo only)
      if (partnerID.trim()) {
        localStorage.setItem('partner_id_verified', partnerID.trim())
      } else {
        localStorage.removeItem('partner_id_verified')
      }

      if (form.gender === 'FEMALE') {
        setShowWomenDialog(true)
      } else {
        toast.success('Registered! Please login.')
        navigate('/login')
      }
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  const field = (label, key, type = 'text', extra = {}) => (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        required
        className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        value={form[key]}
        onChange={e => setForm({ ...form, [key]: e.target.value })}
        {...extra}
      />
    </div>
  )

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-600 to-indigo-800 py-8">
      {/* Women Benefits Dialog — shown once after registration */}
      {showWomenDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            <div className="bg-gradient-to-r from-pink-500 to-purple-600 px-6 py-5 text-white text-center">
              <div className="text-4xl mb-2">🌸</div>
              <h2 className="text-xl font-bold">Special Benefits for Women Workers</h2>
              <p className="text-sm text-pink-100 mt-1">Activated on your account</p>
            </div>
            <div className="px-6 py-5 space-y-3">
              {[
                { icon: '💰', title: 'Lower Premium Rates', desc: '8% discount on your weekly premium — same coverage, less cost.' },
                { icon: '🛡️', title: 'Higher Claim Coverage', desc: '12% higher maximum payout to better protect your income.' },
                { icon: '⏰', title: 'Flexible Payment Support', desc: 'Extra grace period before payment is marked overdue.' },
                { icon: '⚡', title: 'Priority Claim Handling', desc: 'Your claims are flagged for priority review.' },
              ].map(b => (
                <div key={b.title} className="flex items-start gap-3 bg-pink-50 rounded-xl p-3">
                  <span className="text-xl flex-shrink-0">{b.icon}</span>
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{b.title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{b.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="px-6 pb-5">
              <button
                onClick={() => { setShowWomenDialog(false); toast.success('Registered! Please login.'); navigate('/login') }}
                className="w-full bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 text-white font-bold py-3 rounded-xl transition"
              >
                Got it — Let's get started! 🎉
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-lg">
        <div className="flex items-center gap-3 mb-6">
          <Shield className="text-blue-600" size={32} />
          <div>
            <h1 className="text-2xl font-bold">Join AbhayaRaksha</h1>
            <p className="text-sm text-gray-500">Protect your weekly income</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {field('Full Name', 'name')}
            {field('Phone', 'phone', 'tel')}
          </div>
          {field('Email', 'email', 'email')}
          {field('Password', 'password', 'password')}

          {/* Delivery Partner ID — frontend-only KYC placeholder */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Delivery Partner ID <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              placeholder="e.g. SWG-123456 or ZMT-987654"
              value={partnerID}
              onChange={e => { setPartnerID(e.target.value); setPartnerIDError('') }}
              className={`w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                partnerIDError ? 'border-red-400' : 'border-gray-300'
              }`}
            />
            {partnerIDError && (
              <p className="text-xs text-red-500 mt-1">{partnerIDError}</p>
            )}
            <p className="text-xs text-gray-400 mt-1">
              Used for identity verification via partner platforms (simulated for demo)
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Worker Type</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={form.worker_type}
                onChange={e => setForm({ ...form, worker_type: e.target.value })}
              >
                <option value="food_delivery">Food Delivery (Zomato/Swiggy)</option>
                <option value="ecommerce">E-commerce (Amazon/Flipkart)</option>
                <option value="grocery">Grocery (Zepto/Blinkit)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={form.city}
                onChange={handleCityChange}
              >
                {CITIES.map(c => <option key={c.name}>{c.name}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {field('Delivery Zone', 'zone', 'text', { placeholder: 'e.g. Andheri West' })}
            {field('Avg Daily Income (₹)', 'avg_daily_income', 'number', { min: 200, max: 5000 })}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Gender</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={form.gender}
              onChange={e => setForm({ ...form, gender: e.target.value })}
            >
              <option value="">Prefer not to say</option>
              <option value="FEMALE">Female</option>
              <option value="MALE">Male</option>
              <option value="OTHER">Other</option>
            </select>
            {form.gender === 'FEMALE' && (
              <p className="text-xs text-pink-600 mt-1 flex items-center gap-1">
                🌸 You qualify for special women benefits — lower premium, higher coverage &amp; more!
              </p>
            )}
          </div>

          {/* Force Majeure terms — mandatory before account creation */}
          <label className="flex items-start gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={e => setTermsAccepted(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
            />
            <span className="text-xs text-gray-600 leading-relaxed group-hover:text-gray-800 transition">
              I agree to the AbhayaRaksha Policy Terms, including standard actuarial exclusions
              for <strong>War, Pandemics, and Nuclear Hazards</strong> as defined under Force Majeure.
            </span>
          </label>

          <button
            type="submit"
            disabled={loading || !termsAccepted}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Creating account...' : 'Create Account'}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500 mt-4">
          Already registered?{' '}
          <Link to="/login" className="text-blue-600 font-medium hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  )
}

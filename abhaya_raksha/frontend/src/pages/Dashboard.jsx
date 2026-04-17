import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api'
import toast from 'react-hot-toast'
import {
  Shield, TrendingUp, CheckCircle,
  CloudRain, Wind, Thermometer, LogOut, RefreshCw, Info, X, CreditCard
} from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import WithdrawModal from '../components/WithdrawModal'
import ActivationModal from '../components/ActivationModal'
import NotificationBell from '../components/NotificationBell'

function StatCard({ icon: Icon, label, value, color = 'blue', sub }) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    orange: 'bg-orange-50 text-orange-600',
    red: 'bg-red-50 text-red-600',
  }
  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
      <div className="flex items-center gap-3 mb-2">
        <div className={`p-2 rounded-lg ${colors[color]}`}>
          <Icon size={20} />
        </div>
        <span className="text-sm text-gray-500">{label}</span>
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
}

function RiskMeter({ score }) {
  const pct = Math.round(score * 100)
  const color = pct < 30 ? '#22c55e' : pct < 60 ? '#f59e0b' : '#ef4444'
  const label = pct < 30 ? 'Low Risk' : pct < 60 ? 'Moderate Risk' : 'High Risk'
  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
      <h3 className="text-sm font-medium text-gray-500 mb-3">Current Risk Level</h3>
      <div className="flex items-center gap-4">
        <div className="relative w-20 h-20">
          <svg viewBox="0 0 36 36" className="w-20 h-20 -rotate-90">
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="#e5e7eb" strokeWidth="3" />
            <circle
              cx="18" cy="18" r="15.9" fill="none"
              stroke={color} strokeWidth="3"
              strokeDasharray={`${pct} ${100 - pct}`}
              strokeLinecap="round"
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-lg font-bold" style={{ color }}>
            {pct}%
          </span>
        </div>
        <div>
          <p className="font-semibold text-lg" style={{ color }}>{label}</p>
          <p className="text-xs text-gray-400">Updated live</p>
        </div>
      </div>
    </div>
  )
}

// City-specific rain thresholds — mirrors CITY_RAIN_THRESHOLDS in claim_engine.py.
// Keeps warning colours in sync with what actually triggers a backend claim.
const CITY_RAIN_THRESHOLDS = {
  mumbai:    35,
  delhi:     12,
  chennai:   25,
  bangalore: 20,
  hyderabad: 15,
}

function getRainThreshold(city = '') {
  return CITY_RAIN_THRESHOLDS[city.toLowerCase()] ?? 15
}

// Format a UTC ISO timestamp to IST for display.
// SQLite returns naive datetimes (no Z suffix) — append Z so the browser
// correctly parses them as UTC before converting to IST (UTC+5:30).
function toIST(isoString) {
  if (!isoString) return ''
  // Ensure the string is treated as UTC
  const utcString = isoString.endsWith('Z') || isoString.includes('+') ? isoString : isoString + 'Z'
  return new Date(utcString).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
}

export default function Dashboard() {
  const [worker, setWorker] = useState(null)
  const [risk, setRisk] = useState(null)
  const [policy, setPolicy] = useState(null)
  const [claims, setClaims] = useState([])
  const [summary, setSummary] = useState('')
  const [shiftAdvice, setShiftAdvice] = useState('')
  const [loading, setLoading] = useState(true)
  const [withdrawClaim, setWithdrawClaim] = useState(null)
  const [showExclusions, setShowExclusions] = useState(false)
  const [showActivationModal, setShowActivationModal] = useState(false)
  const [isSystemicPause, setIsSystemicPause] = useState(false)
  const navigate = useNavigate()

  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  // ── Policy upgrade offer (read from localStorage, set by admin) ───────────
  const [upgradeOffer, setUpgradeOffer] = useState(null)
  const [upgradeDismissed, setUpgradeDismissed] = useState(false)
  // ── Auto-payout processing animation (UI-only delay) ─────────────────────
  const [processingClaims, setProcessingClaims] = useState(new Set())

  // ── Payment state ─────────────────────────────────────────────────────────
  const [paymentStatus, setPaymentStatus] = useState(null)
  const [payDate, setPayDate] = useState(() => new Date().toISOString().split('T')[0])
  const [payAmount, setPayAmount] = useState('')
  const [paying, setPaying] = useState(false)

  // ── Non-payment state ─────────────────────────────────────────────────────
  const [nonPaymentCase, setNonPaymentCase] = useState(null)
  const [healthFile, setHealthFile] = useState(null)
  const [healthDocDesc, setHealthDocDesc] = useState('')
  const [admissionFrom, setAdmissionFrom] = useState('')
  const [admissionTo, setAdmissionTo] = useState('')
  const [submittingHealth, setSubmittingHealth] = useState(false)
  const [payingFine, setPayingFine] = useState(false)

  // ── Manual claim state ────────────────────────────────────────────────────
  const [manualClaims, setManualClaims] = useState([])
  const [claimAmount, setClaimAmount] = useState('')
  const [claimReason, setClaimReason] = useState('')

  // ── Policy version state ──────────────────────────────────────────────────
  const [activeTemplate, setActiveTemplate] = useState(null)
  const [myPolicyChoice, setMyPolicyChoice] = useState(null)
  const [myTracking, setMyTracking] = useState(null)
  const [choosingPolicy, setChoosingPolicy] = useState(false)

  // ── KYC badge (frontend-only, read from localStorage) ────────────────────
  const partnerIDVerified = localStorage.getItem('partner_id_verified')
  const [submittingClaim, setSubmittingClaim] = useState(false)
  const [claimError, setClaimError] = useState('')

  const loadData = async () => {
    try {
      const [wRes, rRes] = await Promise.all([
        api.get('/workers/me'),
        api.get('/workers/risk')
      ])
      setWorker(wRes.data)
      setRisk(rRes.data)

      try {
        const pRes = await api.get('/policies/active')
        setPolicy(pRes.data)
      } catch { setPolicy(null) }

      const cRes = await api.get('/claims/my')
      setClaims(cRes.data)

      // Systemic pause state — uses the worker-accessible public endpoint
      api.get('/system/status')
        .then(r => setIsSystemicPause(r.data.is_systemic_pause ?? false))
        .catch(() => setIsSystemicPause(false))

      // Load AI summary in background
      api.get('/workers/risk/summary').then(r => setSummary(r.data.summary)).catch(() => {})
      // Smart-Shift advice in background
      api.get('/workers/shift-advice').then(r => setShiftAdvice(r.data.shift_advice)).catch(() => {})
      // Payment status in background
      api.get('/payments/status').then(r => setPaymentStatus(r.data)).catch(() => {})
      // Manual claims in background
      api.get('/manual-claims/my').then(r => setManualClaims(r.data)).catch(() => {})
      // Non-payment status in background
      api.get('/non-payment/status').then(r => setNonPaymentCase(r.data)).catch(() => {})
      // Policy version in background
      api.get('/policy-versions/active').then(r => setActiveTemplate(r.data)).catch(() => {})
      api.get('/policy-versions/my-choice').then(r => setMyPolicyChoice(r.data)).catch(() => {})
      api.get('/policy-versions/my-tracking').then(r => setMyTracking(r.data)).catch(() => {})
    } catch (err) {
      toast.error('Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  // Read upgrade offer from localStorage (set by admin dashboard)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('abhaya_upgrade_offer')
      if (raw) setUpgradeOffer(JSON.parse(raw))
    } catch { /* ignore malformed data */ }
  }, [])

  // Auto-payout animation: show "Processing..." for 800ms for recently-paid claims
  useEffect(() => {
    if (!claims.length) return
    const recentlyPaid = claims.filter(c => {
      if (c.status !== 'paid' || !c.transaction_id) return false
      const age = Date.now() - new Date(c.created_at.endsWith('Z') ? c.created_at : c.created_at + 'Z').getTime()
      return age < 60 * 1000  // within last 60 seconds
    })
    if (!recentlyPaid.length) return
    const ids = new Set(recentlyPaid.map(c => c.id))
    setProcessingClaims(ids)
    const timer = setTimeout(() => setProcessingClaims(new Set()), 800)
    return () => clearTimeout(timer)
  }, [claims])

  // Silently capture worker GPS on mount and push to backend.
  // No UI change — fails gracefully if permission denied or unavailable.
  useEffect(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        api.post('/workers/location', { lat: coords.latitude, lng: coords.longitude }).catch(() => {})
      },
      () => {} // permission denied — ignore
    )
  }, [])

  const handleActivationClose = (didActivate) => {
    setShowActivationModal(false)
    if (didActivate) loadData()
  }

  const handleCancelPolicy = async () => {
    setCancelling(true)
    try {
      await api.post('/policies/cancel')
      toast.success('Coverage stopped. You can activate a new policy anytime.')
      setShowCancelConfirm(false)
      loadData()
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Cancellation failed')
    } finally {
      setCancelling(false)
    }
  }

  const handleWithdrawClose = (didSucceed) => {
    setWithdrawClaim(null)
    if (didSucceed) {
      toast.success('Transfer complete! Your balance has been updated.')
      loadData()
    }
  }

  const handleSubmitClaim = async () => {
    setClaimError('')
    const amt = Number(claimAmount)
    if (!claimAmount || isNaN(amt) || amt <= 0) {
      setClaimError('Enter a valid claim amount.')
      return
    }
    if (amt > 1000) {
      setClaimError('Claim amount cannot exceed ₹1,000 per request.')
      return
    }
    setSubmittingClaim(true)
    try {
      await api.post('/manual-claims', { requested_amount: amt, reason: claimReason || undefined })
      toast.success('Claim submitted successfully!')
      setClaimAmount('')
      setClaimReason('')
      const r = await api.get('/manual-claims/my')
      setManualClaims(r.data)
    } catch (err) {
      setClaimError(err.response?.data?.detail ?? 'Submission failed. Please try again.')
    } finally {
      setSubmittingClaim(false)
    }
  }

  const handlePayPremium = async () => {
    if (!payAmount || isNaN(payAmount) || Number(payAmount) <= 0) {
      toast.error('Enter a valid amount')
      return
    }
    setPaying(true)
    try {
      await api.post('/payments', {
        amount: Number(payAmount),
        payment_date: new Date(payDate).toISOString(),
      })
      toast.success('Payment recorded successfully!')
      setPayAmount('')
      // Refresh payment status
      const r = await api.get('/payments/status')
      setPaymentStatus(r.data)
    } catch (err) {
      toast.error(err.response?.data?.detail ?? 'Payment failed')
    } finally {
      setPaying(false)
    }
  }

  const handleReportHealth = async () => {
    if (!healthFile && !healthDocDesc.trim()) {
      toast.error('Please upload a document or enter a document description')
      return
    }
    setSubmittingHealth(true)
    try {
      let filename = healthDocDesc.trim() || 'document'

      // Upload file if selected
      if (healthFile) {
        const formData = new FormData()
        formData.append('file', healthFile)
        const uploadRes = await api.post('/non-payment/upload-document', formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        })
        filename = uploadRes.data.filename
      }

      const body = {
        document_filename: filename,
        admission_from: admissionFrom ? new Date(admissionFrom).toISOString() : undefined,
        admission_to: admissionTo ? new Date(admissionTo).toISOString() : undefined,
      }
      const r = await api.post('/non-payment/report-health', body)
      setNonPaymentCase(r.data)
      setHealthFile(null)
      setHealthDocDesc('')
      setAdmissionFrom('')
      setAdmissionTo('')
      toast.success('Health issue reported. Admin will review your document.')
    } catch (err) {
      toast.error(err.response?.data?.detail ?? 'Submission failed')
    } finally {
      setSubmittingHealth(false)
    }
  }

  const handlePolicyChoice = async (choice) => {
    setChoosingPolicy(true)
    try {
      const r = await api.post('/policy-versions/choose', { choice })
      setMyPolicyChoice(r.data)
      const tr = await api.get('/policy-versions/my-tracking').catch(() => ({ data: null }))
      setMyTracking(tr.data)
      toast.success(choice === 'NEW' ? 'Switched to new policy!' : 'Staying on existing policy.')
    } catch (err) {
      toast.error(err.response?.data?.detail ?? 'Choice failed')
    } finally {
      setChoosingPolicy(false)
    }
  }

  const handlePayFine = async () => {
    setPayingFine(true)
    try {
      const r = await api.post('/non-payment/pay-fine')
      setNonPaymentCase(r.data)
      toast.success('Fine paid successfully! Your account is now active.')
    } catch (err) {
      toast.error(err.response?.data?.detail ?? 'Payment failed')
    } finally {
      setPayingFine(false)
    }
  }

  const logout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('is_admin')
    navigate('/login')
  }

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
    </div>
  )

  const weeklyIncome = worker ? worker.avg_daily_income * 6 : 0
  const approvedClaims = [
    ...claims.filter(c => c.status === 'approved' || c.status === 'paid'),
    ...manualClaims.filter(c => c.status === 'approved' || c.status === 'paid'),
  ]
  // Total Received = parametric approved/paid claims + manual claims paid by admin
  const parametricPaid = claims.filter(c => c.status === 'paid' || c.status === 'approved').reduce((s, c) => s + c.payout_amount, 0)
  const manualPaid = manualClaims.filter(c => c.status === 'paid').reduce((s, c) => s + c.requested_amount, 0)
  const totalPaid = parametricPaid + manualPaid
  const hasActivePolicy = !!policy

  const claimChartData = ['rain', 'aqi', 'heat', 'curfew'].map(type => ({
    name: type.toUpperCase(),
    count: claims.filter(c => c.trigger_type === type).length
  }))

  return (
    <>
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="text-blue-600" size={28} />
          <div>
            <h1 className="font-bold text-lg text-gray-900">AbhayaRaksha</h1>
            <p className="text-xs text-gray-500">Income Protection Dashboard</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-600">Welcome Back {worker?.name}</span>
          {partnerIDVerified && (
            <span className="text-xs bg-green-100 text-green-700 font-medium px-2 py-0.5 rounded-full flex items-center gap-1">
              ✔ Verified Gig Worker <span className="text-green-400 font-normal">(Simulated)</span>
            </span>
          )}
          <NotificationBell />
          <button onClick={loadData} className="p-2 hover:bg-gray-100 rounded-lg" title="Refresh">
            <RefreshCw size={16} />
          </button>
          <button onClick={logout} className="flex items-center gap-1 text-sm text-gray-500 hover:text-red-500">
            <LogOut size={16} /> Logout
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* Systemic Emergency Banner */}
        {isSystemicPause && (
          <div className="bg-red-600 text-white rounded-xl px-5 py-4 flex items-start gap-3 shadow-lg">
            <span className="text-xl flex-shrink-0">🚨</span>
            <div>
              <p className="font-bold text-sm">SYSTEMIC EMERGENCY: Payouts Temporarily Paused</p>
              <p className="text-xs text-red-100 mt-0.5">
                Automated parametric payouts are suspended for fund sustainability during a
                War / Pandemic / Force Majeure event. Your policy remains active and coverage
                will resume once the emergency is lifted by the platform administrator.
              </p>
            </div>
          </div>
        )}

        {/* ── Current Coverage Card ────────────────────────────────── */}
        {policy && policy.status === 'active' ? (
          <div className="bg-white rounded-xl p-5 shadow-sm border border-green-200">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">🛡️</span>
                <h2 className="font-semibold text-gray-900">Your Active Coverage</h2>
              </div>
              <div className="flex items-center gap-2">
                {(() => {
                  const activatedAt = new Date(policy.start_date.endsWith('Z') ? policy.start_date : policy.start_date + 'Z')
                  const isRecent = (Date.now() - activatedAt.getTime()) < 24 * 60 * 60 * 1000
                  return isRecent ? (
                    <span className="text-xs bg-blue-100 text-blue-700 font-medium px-2 py-0.5 rounded-full">Recently Updated</span>
                  ) : null
                })()}
                <span className="text-xs bg-green-100 text-green-700 font-semibold px-2.5 py-0.5 rounded-full">Active</span>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
              <div className="bg-green-50 rounded-lg p-3">
                <p className="text-xs text-gray-500 mb-0.5">Weekly Premium</p>
                <p className="text-sm font-bold text-green-700">₹{Math.round(policy.weekly_premium).toLocaleString()}</p>
              </div>
              <div className="bg-green-50 rounded-lg p-3">
                <p className="text-xs text-gray-500 mb-0.5">Coverage Amount</p>
                <p className="text-sm font-bold text-green-700">₹{Math.round(policy.coverage_amount).toLocaleString()}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500 mb-0.5">Started On</p>
                <p className="text-sm font-semibold text-gray-700">{new Date(policy.start_date.endsWith('Z') ? policy.start_date : policy.start_date + 'Z').toLocaleDateString('en-IN')}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500 mb-0.5">Valid Till</p>
                <p className="text-sm font-semibold text-gray-700">{new Date(policy.end_date.endsWith('Z') ? policy.end_date : policy.end_date + 'Z').toLocaleDateString('en-IN')}</p>
              </div>
            </div>
            <p className="text-xs text-green-700">✓ Your income is currently protected under active coverage.</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-gray-500">Payment Health:</span>
              {policy.weekly_premium > 150 ? (
                <span className="text-xs bg-red-100 text-red-700 font-medium px-2 py-0.5 rounded-full">⚠️ At Risk</span>
              ) : (
                <span className="text-xs bg-green-100 text-green-700 font-medium px-2 py-0.5 rounded-full">✓ Good Standing</span>
              )}
              {policy.weekly_premium > 150 && (
                <span className="text-xs text-gray-500 ml-1">Consider switching to a lower plan for better affordability.</span>
              )}
            </div>
            {policy.weekly_premium > 150 && (
              <button
                onClick={() => setShowActivationModal(true)}
                disabled={isSystemicPause}
                className="mt-2 text-xs text-blue-600 hover:text-blue-800 underline disabled:opacity-50"
              >
                Switch Plan
              </button>
            )}
          </div>
        ) : !policy ? (
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-200">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-lg">🛡️</span>
              <h2 className="font-semibold text-gray-900">Your Active Coverage</h2>
              <span className="text-xs bg-gray-100 text-gray-500 font-medium px-2.5 py-0.5 rounded-full ml-auto">Inactive</span>
            </div>
            <p className="text-sm text-gray-500">You are not currently protected. Activate a plan to start income protection.</p>
          </div>
        ) : null}

        {/* ── Policy Upgrade Offer Card ─────────────────────────────── */}
        {upgradeOffer && !upgradeDismissed && (
          <div className="bg-blue-50 rounded-xl p-5 border border-blue-200">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">🚀</span>
                <div>
                  <h3 className="font-semibold text-blue-900">{upgradeOffer.title || 'New Coverage Plan Available'}</h3>
                  <p className="text-xs text-blue-600 mt-0.5">Limited time upgrade offer from AbhayaRaksha</p>
                </div>
              </div>
              <button
                onClick={() => setUpgradeDismissed(true)}
                className="text-blue-400 hover:text-blue-600 flex-shrink-0"
                aria-label="Dismiss upgrade offer"
              >
                <X size={16} />
              </button>
            </div>
            {upgradeOffer.message && (
              <ul className="space-y-1 mb-3">
                {upgradeOffer.message.split('\n').filter(Boolean).map((b, i) => (
                  <li key={i} className="text-xs text-blue-800 flex items-start gap-1.5">
                    <span className="text-blue-400 flex-shrink-0">•</span> {b}
                  </li>
                ))}
              </ul>
            )}
            {upgradeOffer.coverage && (
              <p className="text-sm font-semibold text-blue-800 mb-3">
                New Coverage: ₹{Number(upgradeOffer.coverage).toLocaleString()}
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setUpgradeDismissed(true)
                  setShowActivationModal(true)
                }}
                disabled={isSystemicPause}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-4 py-2 rounded-lg text-sm transition"
              >
                Upgrade Plan
              </button>
              <button
                onClick={() => setUpgradeDismissed(true)}
                className="text-xs text-blue-600 hover:text-blue-800 px-3 py-2"
              >
                Maybe later
              </button>
            </div>
          </div>
        )}

        {/* ── No active policy — show Activation Card only ─────────── */}
        {!hasActivePolicy && (
          <div className="flex items-center justify-center min-h-[60vh]">
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 w-full max-w-md p-8 space-y-6">
              <div className="text-center space-y-2">
                <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto">
                  <Shield className="text-blue-600" size={32} />
                </div>
                <h2 className="text-xl font-bold text-gray-900">Protect Your Income</h2>
                <p className="text-sm text-gray-500">
                  You don't have an active policy. Activate now to get automatic payouts
                  when rain, AQI, or heat disrupts your deliveries.
                </p>
              </div>

              {risk && (
                <div className="bg-blue-50 rounded-xl p-4 space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Weekly premium</span>
                    <span className="font-bold text-blue-700">₹{risk.weekly_premium?.toLocaleString()}/week <span className="text-xs font-normal text-green-600">inclusive</span></span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Income protected</span>
                    <span className="font-semibold text-green-700">₹{risk.coverage_amount?.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Your risk score</span>
                    <span className="text-gray-700">{Math.round(risk.risk_score * 100)}% — {risk.risk_score < 0.3 ? 'Low' : risk.risk_score < 0.6 ? 'Moderate' : 'High'}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Coverage window</span>
                    <span className="text-gray-700">7 days</span>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <button
                  onClick={() => setShowActivationModal(true)}
                  disabled={isSystemicPause}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  {isSystemicPause ? '🚨 Paused — Emergency Active' : 'Activate Weekly Policy'}
                </button>
                <button
                  onClick={() => setShowExclusions(true)}
                  className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-500 hover:text-blue-600 transition"
                >
                  <Info size={13} /> View policy exclusions & Force Majeure terms
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Active policy — full dashboard ────────────────────────── */}
        {hasActivePolicy && (<>

        {/* ── Policy Update Banner ─────────────────────────────────────── */}
        {activeTemplate && !myPolicyChoice && (
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl p-5 shadow-lg">
            <div className="flex items-start gap-3 mb-4">
              <span className="text-2xl flex-shrink-0">📋</span>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-bold text-lg">New Policy Available — v{activeTemplate.version}</h3>
                  <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full">Action Required</span>
                </div>
                <p className="text-sm text-blue-100">{activeTemplate.name}</p>
                {activeTemplate.description && (
                  <p className="text-xs text-blue-200 mt-1">{activeTemplate.description}</p>
                )}
              </div>
            </div>

            {/* Benefits */}
            {activeTemplate.benefits && (
              <div className="bg-white/10 rounded-lg p-3 mb-4">
                <p className="text-xs font-semibold text-blue-100 mb-2">✨ What's New</p>
                <ul className="space-y-1">
                  {activeTemplate.benefits.split('\n').filter(Boolean).map((b, i) => (
                    <li key={i} className="text-xs text-white flex items-start gap-1.5">
                      <span className="text-green-300 flex-shrink-0">•</span> {b}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Premium info */}
            <div className="bg-white/10 rounded-lg p-3 mb-4 flex items-center justify-between">
              <div>
                <p className="text-xs text-blue-200">New policy premium</p>
                <p className="font-bold text-white">
                  ₹{policy ? Math.round(policy.weekly_premium * activeTemplate.premium_multiplier) : Math.round(activeTemplate.base_premium)}/week
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-blue-200">Current premium</p>
                <p className="font-semibold text-blue-100">₹{risk ? risk.weekly_premium.toLocaleString() : (policy ? Math.round(policy.weekly_premium) : '—')}/week</p>
              </div>
              <div className="text-right">
                <span className="text-xs bg-yellow-400 text-yellow-900 font-bold px-2 py-0.5 rounded-full">
                  +{Math.round((activeTemplate.premium_multiplier - 1) * 100)}% premium
                </span>
              </div>
            </div>

            {/* Choice buttons */}
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => handlePolicyChoice('NEW')}
                disabled={choosingPolicy}
                className="flex-1 bg-white text-blue-700 font-bold py-2.5 rounded-xl text-sm hover:bg-blue-50 transition disabled:opacity-50"
              >
                {choosingPolicy ? '…' : '✅ Switch to New Policy'}
              </button>
              <button
                onClick={() => handlePolicyChoice('EXISTING')}
                disabled={choosingPolicy}
                className="flex-1 bg-white/20 hover:bg-white/30 text-white font-semibold py-2.5 rounded-xl text-sm transition disabled:opacity-50"
              >
                {choosingPolicy ? '…' : '🔒 Continue Existing Policy'}
              </button>
            </div>
          </div>
        )}

        {/* Policy choice confirmation */}
        {activeTemplate && myPolicyChoice && (
          <div className={`rounded-xl border p-4 flex items-center gap-3 ${
            myPolicyChoice.choice === 'NEW'
              ? 'bg-blue-50 border-blue-200'
              : 'bg-gray-50 border-gray-200'
          }`}>
            <span className="text-xl">{myPolicyChoice.choice === 'NEW' ? '🆕' : '🔒'}</span>
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-800">
                {myPolicyChoice.choice === 'NEW'
                  ? `You're on ${activeTemplate.name} (v${activeTemplate.version})`
                  : 'You are on your previous policy'}
              </p>
              {myPolicyChoice.choice === 'NEW' && myPolicyChoice.adjusted_premium && (
                <p className="text-xs text-blue-600">Weekly premium: ₹{myPolicyChoice.adjusted_premium.toLocaleString()}</p>
              )}
              {myTracking && (
                <p className="text-xs text-gray-500 mt-0.5">
                  90-day tracking: {myTracking.irregular_count} missed week{myTracking.irregular_count !== 1 ? 's' : ''}
                  {myTracking.is_irregular && <span className="text-orange-600 ml-1">⚠️ Irregular</span>}
                  {' · '}Ends {new Date(
                    myTracking.tracking_end.endsWith('Z') ? myTracking.tracking_end : myTracking.tracking_end + 'Z'
                  ).toLocaleDateString('en-IN')}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Smart-Shift Planner */}
        {shiftAdvice && (
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">🛡️</span>
              <span className="text-sm font-semibold text-gray-800">Abhaya Smart-Shift</span>
              <span className="ml-auto text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Tomorrow's forecast</span>
            </div>
            <p className="text-sm text-gray-700 leading-relaxed">{shiftAdvice}</p>
          </div>
        )}
        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard icon={TrendingUp} label="Weekly Income" value={`₹${weeklyIncome.toLocaleString()}`} color="blue" sub="6 working days" />
          <StatCard icon={Shield} label="Protected Weekly Income" value={risk ? `₹${risk.coverage_amount.toLocaleString()}` : '—'} color="green" sub="Max weekly payout" />
          <StatCard icon={CheckCircle} label="Claims Approved" value={approvedClaims.length} color="orange" sub="This account" />
          <StatCard icon={TrendingUp} label="Total Received" value={`₹${totalPaid.toLocaleString()}`} color="green" sub="Approved + paid payouts" />
        </div>

        {/* Women Benefits Badge */}
        {worker?.gender === 'FEMALE' && (
          <div className="bg-gradient-to-r from-pink-50 to-purple-50 border border-pink-200 rounded-xl px-5 py-3 flex items-center gap-3">
            <span className="text-2xl">🌸</span>
            <div className="flex-1">
              <p className="text-sm font-semibold text-pink-700">Women Benefits Active</p>
              <p className="text-xs text-pink-500">
                8% lower premium · {risk?.women_benefits_active ? `₹${risk.coverage_amount.toLocaleString()} coverage (+12%)` : 'Higher coverage'} · Flexible payment · Priority claims
              </p>
            </div>
            <span className="text-xs bg-pink-100 text-pink-700 font-medium px-2 py-0.5 rounded-full">Active</span>
          </div>
        )}

        {/* Risk + Policy Row */}
        <div className="grid md:grid-cols-3 gap-4">
          {risk && <RiskMeter score={risk.risk_score} />}

          {/* Weather Conditions */}
          {risk && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <h3 className="text-sm font-medium text-gray-500 mb-3">Live Conditions – {risk.city}</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-blue-500">
                    <CloudRain size={16} /> <span className="text-sm">Rainfall</span>
                  </div>
                  {(() => {
                    const threshold = getRainThreshold(risk.city)
                    const warn = risk.rain_mm >= threshold
                    return (
                      <span className={`text-sm font-semibold ${warn ? 'text-red-500' : 'text-gray-700'}`}>
                        {risk.rain_mm} mm {warn ? `⚠️ ≥${threshold}mm` : '✓'}
                      </span>
                    )
                  })()}
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-purple-500">
                    <Wind size={16} /> <span className="text-sm">AQI</span>
                  </div>
                  <span className={`text-sm font-semibold ${risk.aqi >= 200 ? 'text-red-500' : 'text-gray-700'}`}>
                    {risk.aqi} {risk.aqi >= 200 ? '⚠️' : '✓'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-orange-500">
                    <Thermometer size={16} /> <span className="text-sm">Temperature</span>
                  </div>
                  <span className={`text-sm font-semibold ${risk.temp_c >= 42 ? 'text-red-500' : 'text-gray-700'}`}>
                    {Math.round(risk.temp_c)}°C {risk.temp_c >= 42 ? '⚠️' : '✓'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Policy Card */}
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-500">Your Policy</h3>
              <button
                onClick={() => setShowExclusions(true)}
                className="text-gray-400 hover:text-blue-500 transition"
                title="View policy exclusions & Force Majeure terms"
                aria-label="View policy exclusions"
              >
                <Info size={15} />
              </button>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span className="text-sm font-semibold text-green-600">Active</span>
              </div>
              <p className="text-2xl font-bold text-gray-900">₹{
                myPolicyChoice?.choice === 'NEW' && myPolicyChoice?.adjusted_premium
                  ? myPolicyChoice.adjusted_premium.toLocaleString()
                  : risk ? risk.weekly_premium.toLocaleString() : Math.round(policy.weekly_premium)
              }/week</p>
              <p className="text-xs text-gray-500">Protected weekly income: ₹{risk ? risk.coverage_amount.toLocaleString() : Math.round(policy.coverage_amount).toLocaleString()}</p>
              <p className="text-xs text-green-600 font-medium">✓ Inclusive micro-insurance pricing</p>
              <p className="text-xs text-gray-400 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block"></span>
                Auto-debited weekly via UPI (simulated) · 🟢 Auto-pay enabled
              </p>
              <div className="mt-2 bg-blue-50 border border-blue-200 rounded-md p-2">
                <p className="text-xs text-blue-600">
                  📍 Claims are triggered based on hyperlocal weather data and GPS verification to ensure accuracy.
                </p>
              </div>
              <p className="text-xs text-gray-400">
                Expires: {new Date(policy.end_date).toLocaleDateString('en-IN')}
              </p>
              {policy.status === 'active' && (
                <div className="flex justify-end pt-1">
                  <button
                    onClick={() => setShowCancelConfirm(true)}
                    className="text-xs text-red-500 hover:text-red-700 underline"
                  >
                    Stop Coverage
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* AI Summary */}
        {summary && (
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">🤖</span>
              <span className="text-sm font-semibold text-blue-700">AI Risk Summary</span>
            </div>
            <p className="text-sm text-gray-700 leading-relaxed">{summary}</p>
          </div>
        )}

        {/* Claims History */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="px-5 py-4 border-b border-gray-100">
            <h3 className="font-semibold text-gray-900">Claims History</h3>
          </div>
          {claims.length === 0 && manualClaims.length === 0 ? (
            <div className="p-8 text-center text-gray-400">
              <Shield size={40} className="mx-auto mb-2 opacity-30" />
              <p>No claims yet. Claims trigger automatically when disruptions occur.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {/* Merge and sort all claims newest-first */}
              {[
                ...claims.map(c => ({ ...c, _type: 'parametric' })),
                ...manualClaims.map(c => ({ ...c, _type: 'manual' })),
              ]
                .sort((a, b) => new Date(b.created_at + (b.created_at.endsWith('Z') ? '' : 'Z')) - new Date(a.created_at + (a.created_at.endsWith('Z') ? '' : 'Z')))
                .map(claim => claim._type === 'parametric' ? (
                <div key={`p-${claim.id}`} className="px-5 py-4 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium capitalize">{claim.trigger_type} disruption</span>
                      <span className="text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">auto</span>
                      {claim.fraud_score > 0.4 && (
                        <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full">
                          ⚠️ Fraud flag
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {toIST(claim.created_at)} IST •
                      Value: {claim.trigger_value} (threshold: {claim.trigger_threshold})
                    </p>
                    <p className="text-xs text-gray-500 italic mt-0.5">
                      {claim.trigger_type === 'rain' && 'Heavy rain disrupted your shift. Your income was protected automatically.'}
                      {claim.trigger_type === 'aqi' && 'Poor air quality made outdoor work unsafe. Your income was protected automatically.'}
                      {claim.trigger_type === 'heat' && 'Extreme heat disrupted your shift. Your income was protected automatically.'}
                      {claim.trigger_type === 'curfew' && 'Zone closure prevented you from working. Your income was protected automatically.'}
                      {claim.trigger_type === 'flood' && 'Flooding disrupted your shift. Your income was protected automatically.'}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="font-semibold text-gray-900">₹{claim.payout_amount.toLocaleString()}</p>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        claim.status === 'paid' ? 'bg-green-100 text-green-700' :
                        claim.status === 'approved' ? 'bg-blue-100 text-blue-700' :
                        claim.status === 'rejected' ? 'bg-red-100 text-red-700' :
                        'bg-yellow-100 text-yellow-700'
                      }`}>
                        {claim.status}
                      </span>
                    </div>
                    {claim.status === 'approved' && (
                      <span className="text-xs px-3 py-1.5 rounded-lg bg-yellow-100 text-yellow-700 font-medium">
                        ⏳ Processing payout...
                      </span>
                    )}
                    {claim.status === 'paid' && (
                      <div className="text-right">
                        {processingClaims.has(claim.id) ? (
                          <span className="text-xs px-3 py-1.5 rounded-lg bg-yellow-100 text-yellow-700 font-medium">
                            ⏳ Processing payout...
                          </span>
                        ) : (
                          <div>
                            <span className="text-xs px-3 py-1.5 rounded-lg bg-green-100 text-green-700 font-medium">
                              ✅ ₹{claim.payout_amount.toLocaleString()} credited
                            </span>
                            {claim.transaction_id && (
                              <p className="text-xs text-gray-400 mt-1">TXN: {claim.transaction_id}</p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div key={`m-${claim.id}`} className="px-5 py-4 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">Manual claim request</span>
                      <span className="text-xs bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full">manual</span>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {toIST(claim.created_at)} IST
                      {claim.reason && ` • ${claim.reason}`}
                      {claim.transaction_id && ` • TXN: ${claim.transaction_id}`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-gray-900">₹{claim.requested_amount.toLocaleString()}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      claim.status === 'paid'     ? 'bg-green-100 text-green-700' :
                      claim.status === 'approved' ? 'bg-blue-100 text-blue-700' :
                      claim.status === 'rejected' ? 'bg-red-100 text-red-700' :
                                                    'bg-yellow-100 text-yellow-700'
                    }`}>
                      {claim.status.charAt(0).toUpperCase() + claim.status.slice(1)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Claims Chart */}
        {claims.length > 0 && (
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <h3 className="font-semibold text-gray-900 mb-4">Claims by Trigger Type</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={claimChartData}>
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {claimChartData.map((_, i) => (
                    <Cell key={i} fill={['#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444'][i]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ── Claim Insurance ──────────────────────────────────────────── */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-4">
            <div className="p-2 rounded-lg bg-orange-50 text-orange-600">
              <Shield size={18} />
            </div>
            <h3 className="font-semibold text-gray-900">Claim Insurance</h3>
            <span className="ml-auto text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Max ₹1,000 per claim</span>
          </div>

          {/* Claim form */}
          <div className="flex flex-col sm:flex-row gap-3 mb-3">
            <div className="flex-1">
              <label className="text-xs text-gray-500 mb-1 block">Claim Amount (₹) — max ₹1,000</label>
              <input
                type="number"
                min="1"
                max="1000"
                placeholder="e.g. 500"
                value={claimAmount}
                onChange={e => { setClaimAmount(e.target.value); setClaimError('') }}
                className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 ${
                  claimError ? 'border-red-400' : 'border-gray-200'
                }`}
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-500 mb-1 block">Reason (optional)</label>
              <input
                type="text"
                placeholder="e.g. Rain disruption, AQI spike"
                value={claimReason}
                onChange={e => setClaimReason(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={handleSubmitClaim}
                disabled={submittingClaim}
                className="w-full sm:w-auto bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-semibold px-5 py-2 rounded-lg text-sm transition"
              >
                {submittingClaim ? 'Submitting…' : 'Submit Claim'}
              </button>
            </div>
          </div>

          {/* Validation error */}
          {claimError && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
              ⚠️ {claimError}
            </p>
          )}
        </div>

        {/* ── Non-Payment Status ───────────────────────────────────────── */}
        {nonPaymentCase && nonPaymentCase.payment_status === 'BLOCKED' && (
          <div className="bg-red-50 border-2 border-red-400 rounded-xl p-6 text-center space-y-3">
            <div className="text-4xl">🚫</div>
            <h3 className="font-bold text-red-700 text-lg">Account Blocked</h3>
            <p className="text-sm text-red-600">
              Your account has been blocked due to non-payment without a valid reason.
              You can re-register and take a new policy after 6 months.
            </p>
            {nonPaymentCase.block_until && (
              <p className="text-xs text-red-500 font-medium">
                Block expires: {new Date(
                  nonPaymentCase.block_until.endsWith('Z') ? nonPaymentCase.block_until : nonPaymentCase.block_until + 'Z'
                ).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
              </p>
            )}
          </div>
        )}

        {nonPaymentCase && nonPaymentCase.payment_status !== 'BLOCKED' && (
          <>
          {/* Health case status card */}
          {nonPaymentCase.non_payment_reason === 'HEALTH' && (
            <div className={`rounded-xl border p-5 ${
              nonPaymentCase.document_status === 'APPROVED' ? 'bg-blue-50 border-blue-200' :
              nonPaymentCase.document_status === 'REJECTED' ? 'bg-red-50 border-red-200' :
              'bg-yellow-50 border-yellow-200'
            }`}>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-lg">🩺</span>
                <h3 className="font-semibold text-gray-900">Health Issue Case</h3>
                <span className={`ml-auto text-xs font-medium px-2 py-0.5 rounded-full ${
                  nonPaymentCase.document_status === 'APPROVED' ? 'bg-blue-100 text-blue-700' :
                  nonPaymentCase.document_status === 'REJECTED' ? 'bg-red-100 text-red-700' :
                  'bg-yellow-100 text-yellow-700'
                }`}>
                  Doc: {nonPaymentCase.document_status || 'Not submitted'}
                </span>
              </div>
              <div className="space-y-1 text-sm text-gray-600">
                {nonPaymentCase.health_case_type && (
                  <p>Case type: <span className="font-semibold">{nonPaymentCase.health_case_type}</span></p>
                )}
                {nonPaymentCase.health_case_type === 'MINOR' && (
                  <p className="text-xs text-blue-700">
                    ✓ Resume payments when recovered. A 10% premium increase will apply.
                  </p>
                )}
                {nonPaymentCase.health_case_type === 'MAJOR' && nonPaymentCase.fine_amount && !nonPaymentCase.fine_paid && (
                  <div className="mt-3 space-y-2">
                    <p className="text-orange-700 font-medium">
                      Fine due: ₹{nonPaymentCase.fine_amount.toLocaleString()} (within 1 month)
                    </p>
                    <button
                      onClick={handlePayFine}
                      disabled={payingFine}
                      className="bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded-lg transition"
                    >
                      {payingFine ? 'Processing…' : `Pay Fine ₹${nonPaymentCase.fine_amount.toLocaleString()}`}
                    </button>
                  </div>
                )}
                {nonPaymentCase.health_case_type === 'MAJOR' && nonPaymentCase.fine_paid && (
                  <p className="text-green-700 font-medium">✓ Fine paid. Account restored.</p>
                )}
                {nonPaymentCase.document_status === 'REJECTED' && (
                  <p className="text-red-600 text-xs">
                    Document rejected. Please ensure your premium payments are up to date.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Report health issue form — shown when payment is pending and no health case yet */}
          {paymentStatus && paymentStatus.total_due > 0 && nonPaymentCase.non_payment_reason !== 'HEALTH' && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-orange-200">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-lg">🩺</span>
                <h3 className="font-semibold text-gray-900">Can't Pay? Report Health Issue</h3>
              </div>
              <p className="text-xs text-gray-500 mb-4">
                Upload a prescription or hospital document and provide your admission dates for admin review.
              </p>
              <div className="space-y-3">
                {/* File upload */}
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Upload Document (PDF / JPG / PNG, max 5MB)</label>
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png"
                    onChange={e => setHealthFile(e.target.files?.[0] || null)}
                    className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-orange-50 file:text-orange-700 hover:file:bg-orange-100"
                  />
                  {healthFile && (
                    <p className="text-xs text-green-600 mt-1">✓ {healthFile.name}</p>
                  )}
                </div>
                {/* Fallback description if no file */}
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Or describe your document (if upload not possible)</label>
                  <input
                    type="text"
                    placeholder="e.g. Doctor prescription dated 16-Apr-2026"
                    value={healthDocDesc}
                    onChange={e => setHealthDocDesc(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                </div>
                {/* Admission dates */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Admission Date (From)</label>
                    <input
                      type="date"
                      value={admissionFrom}
                      onChange={e => setAdmissionFrom(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Discharge Date (To)</label>
                    <input
                      type="date"
                      value={admissionTo}
                      onChange={e => setAdmissionTo(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                    />
                  </div>
                </div>
                <button
                  onClick={handleReportHealth}
                  disabled={submittingHealth}
                  className="w-full bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-semibold py-2 rounded-lg text-sm transition"
                >
                  {submittingHealth ? 'Submitting…' : 'Submit Health Report'}
                </button>
              </div>
            </div>
          )}
          </>
        )}

        {/* ── Pay Premium ──────────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-4">
            <div className="p-2 rounded-lg bg-blue-50 text-blue-600">
              <CreditCard size={18} />
            </div>
            <h3 className="font-semibold text-gray-900">Pay Premium</h3>
          </div>

          {/* Status strip */}
          {paymentStatus && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500 mb-1">This Week</p>
                <span className={`text-sm font-semibold px-2 py-0.5 rounded-full ${
                  paymentStatus.current_week_status === 'PAID'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-yellow-100 text-yellow-700'
                }`}>
                  {paymentStatus.current_week_status === 'PAID' ? '✓ Completed' : '⏳ Pending'}
                </span>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500 mb-1">Total Due</p>
                <p className="text-sm font-bold text-red-600">
                  {paymentStatus.total_due > 0 ? `₹${paymentStatus.total_due.toLocaleString()}` : '—'}
                </p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500 mb-1">Advance Paid</p>
                <p className="text-sm font-bold text-blue-600">
                  {paymentStatus.advance_count > 0
                    ? `${paymentStatus.advance_count} week${paymentStatus.advance_count > 1 ? 's' : ''}`
                    : '—'}
                </p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-xs text-gray-500 mb-1">Advance Total</p>
                <p className="text-sm font-bold text-blue-600">
                  {paymentStatus.advance_total > 0 ? `₹${paymentStatus.advance_total.toLocaleString()}` : '—'}
                </p>
              </div>
            </div>
          )}

          {/* Payment form */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label className="text-xs text-gray-500 mb-1 block">Payment Date</label>
              <input
                type="date"
                value={payDate}
                onChange={e => setPayDate(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-500 mb-1 block">
                Amount (₹)
                {policy && (
                  <span className="ml-1 text-gray-400">
                    — suggested ₹{Math.round(policy.weekly_premium)}
                  </span>
                )}
              </label>
              <input
                type="number"
                min="1"
                placeholder={policy ? Math.round(policy.weekly_premium) : ''}
                value={payAmount}
                onChange={e => setPayAmount(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={handlePayPremium}
                disabled={paying}
                className="w-full sm:w-auto bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-5 py-2 rounded-lg text-sm transition"
              >
                {paying ? 'Processing…' : 'Pay Now'}
              </button>
            </div>
          </div>

          {/* Recent payment history (last 5) */}
          {paymentStatus?.payments?.length > 0 && (
            <div className="mt-4 border-t border-gray-100 pt-4">
              <p className="text-xs font-medium text-gray-500 mb-2">Recent Payments</p>
              <div className="space-y-1.5">
                {paymentStatus.payments.slice(0, 5).map(p => (
                  <div key={p.id} className="flex items-center justify-between text-xs">
                    <span className="text-gray-600">
                      Week of {new Date(p.week_start_date).toLocaleDateString('en-IN')}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-800">₹{p.amount.toLocaleString()}</span>
                      <span className={`px-1.5 py-0.5 rounded-full font-medium ${
                        p.status === 'PAID'    ? 'bg-green-100 text-green-700' :
                        p.status === 'ADVANCE' ? 'bg-blue-100 text-blue-700' :
                                                 'bg-yellow-100 text-yellow-700'
                      }`}>
                        {p.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        </>)}

        {/* 🛡️ Trusted & Compliant Platform */}
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mt-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-base">🛡️</span>
            <span className="text-sm font-semibold text-blue-800">Trusted &amp; Compliant Platform</span>
          </div>
          <ul className="space-y-1 text-xs text-blue-700">
            <li>• IRDAI-aligned parametric insurance model</li>
            <li>• Fully automated, zero-touch claim processing</li>
            <li>• GPS used only for fraud prevention with user consent (DPDP compliant)</li>
            <li>• Designed for transparency and instant payouts</li>
            <li>• 📍 Claims triggered using hyperlocal weather data and GPS verification</li>
          </ul>
          <p className="text-xs text-gray-600 mt-2">Your data is secure. Your claims are automatic.</p>
        </div>
      </main>
    </div>

    {/* Withdraw modal */}
    {withdrawClaim && (
      <WithdrawModal claim={withdrawClaim} onClose={handleWithdrawClose} />
    )}

    {/* Activation modal */}
    {showActivationModal && (
      <ActivationModal
        risk={risk}
        onClose={handleActivationClose}
        onShowTerms={() => { setShowActivationModal(false); setShowExclusions(true) }}
      />
    )}

    {/* Policy Exclusions & Force Majeure modal */}
    {showExclusions && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onClick={e => { if (e.target === e.currentTarget) setShowExclusions(false) }}
      >
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <Shield className="text-blue-600" size={20} />
              <h2 className="font-bold text-gray-900">Policy Exclusions & Force Majeure</h2>
            </div>
            <button onClick={() => setShowExclusions(false)} className="text-gray-400 hover:text-gray-600 transition">
              <X size={20} />
            </button>
          </div>
          <div className="px-6 py-5 space-y-4">
            <p className="text-sm text-gray-600 leading-relaxed">
              To ensure long-term fund sustainability for all workers, coverage is explicitly
              excluded for losses resulting from:
            </p>
            <ol className="space-y-3">
              {[
                { n: '1', title: 'Acts of War or Terrorism', desc: 'Any loss directly or indirectly caused by declared or undeclared war, invasion, civil war, or acts of terrorism.' },
                { n: '2', title: 'Global Pandemics', desc: 'Disruptions arising from events classified as a Public Health Emergency of International Concern (PHEIC) or pandemic by the World Health Organization (WHO).' },
                { n: '3', title: 'Radioactive / Nuclear Contamination', desc: 'Any loss attributable to ionising radiation, radioactive contamination, or nuclear reaction from any source.' },
              ].map(item => (
                <li key={item.n} className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-red-100 text-red-600 text-xs font-bold flex items-center justify-center">
                    {item.n}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{item.title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-700 leading-relaxed">
              These exclusions are standard actuarial practice in parametric insurance and protect
              the fund from systemic, uninsurable risks that would otherwise cause insolvency.
            </div>
          </div>
          <div className="px-6 pb-5">
            <button
              onClick={() => setShowExclusions(false)}
              className="w-full bg-gray-900 hover:bg-gray-800 text-white font-semibold py-2.5 rounded-xl transition text-sm"
            >
              Understood
            </button>
          </div>
        </div>
      </div>
    )}
    {/* Cancel Policy confirmation modal */}
    {showCancelConfirm && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        onClick={e => { if (e.target === e.currentTarget) setShowCancelConfirm(false) }}
      >
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <Shield className="text-red-500" size={20} />
              <h2 className="font-bold text-gray-900">Stop Weekly Coverage?</h2>
            </div>
            <button onClick={() => setShowCancelConfirm(false)} className="text-gray-400 hover:text-gray-600 transition">
              <X size={20} />
            </button>
          </div>
          <div className="px-6 py-5">
            <p className="text-sm text-gray-600 leading-relaxed">
              Your income protection will stop immediately. You will not receive payouts after cancellation.
              Existing approved claims are not affected.
            </p>
          </div>
          <div className="px-6 pb-5 flex gap-3">
            <button
              onClick={() => setShowCancelConfirm(false)}
              className="flex-1 bg-gray-900 hover:bg-gray-800 text-white font-semibold py-2.5 rounded-xl transition text-sm"
            >
              Keep Coverage
            </button>
            <button
              onClick={handleCancelPolicy}
              disabled={cancelling}
              className="flex-1 bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl transition text-sm"
            >
              {cancelling ? 'Stopping…' : 'Yes, Stop Coverage'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  )
}

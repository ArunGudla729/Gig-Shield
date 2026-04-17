import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'
import NotificationBell from '../components/NotificationBell'
import toast from 'react-hot-toast'
import {
  Users, Shield, TrendingUp,
  DollarSign, Activity, Zap, ShieldAlert, Bell, MapPin, CreditCard
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Legend
} from 'recharts'

function StatCard({ icon: Icon, label, value, color, sub }) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    orange: 'bg-orange-50 text-orange-600',
    red: 'bg-red-50 text-red-600',
    purple: 'bg-purple-50 text-purple-600',
  }
  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
      <div className="flex items-center gap-3 mb-2">
        <div className={`p-2 rounded-lg ${colors[color] || colors.blue}`}>
          <Icon size={20} />
        </div>
        <span className="text-sm text-gray-500">{label}</span>
      </div>
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  )
}

// Format a UTC ISO timestamp to IST for display.
// SQLite returns naive datetimes (no Z suffix) — append Z so the browser
// correctly parses them as UTC before converting to IST (UTC+5:30).
function toIST(isoString) {
  if (!isoString) return ''
  const utcString = isoString.endsWith('Z') || isoString.includes('+') ? isoString : isoString + 'Z'
  return new Date(utcString).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
}

export default function AdminDashboard() {
  const [stats, setStats] = useState(null)
  const [claims, setClaims] = useState([])
  const [fraudAlerts, setFraudAlerts] = useState([])
  const [weekly, setWeekly] = useState([])
  const [heatmap, setHeatmap] = useState([])
  const [insight, setInsight] = useState('')
  const [loading, setLoading] = useState(true)
  const [isPaused, setIsPaused] = useState(false)
  const [pauseToggling, setPauseToggling] = useState(false)
  const [health, setHealth] = useState(null)
  const [simulating, setSimulating] = useState(false)
  // ── Payment tracking ──────────────────────────────────────────────────────
  const [paymentSummary, setPaymentSummary] = useState([])
  const [paymentTotals, setPaymentTotals] = useState(null)
  // ── Manual claims ─────────────────────────────────────────────────────────
  const [pendingManualClaims, setPendingManualClaims] = useState([])
  const [approvedManualClaims, setApprovedManualClaims] = useState([])
  const [claimActionLoading, setClaimActionLoading] = useState({})
  // ── Non-payment cases ─────────────────────────────────────────────────────
  const [pendingHealthCases, setPendingHealthCases] = useState([])
  const [blockedWorkers, setBlockedWorkers] = useState([])
  const [npActionLoading, setNpActionLoading] = useState({})
  // ── Policy versioning ─────────────────────────────────────────────────────
  const [activeTemplate, setActiveTemplate] = useState(null)
  const [adoptionSummary, setAdoptionSummary] = useState(null)
  const [adoptionList, setAdoptionList] = useState([])
  const [showPolicyForm, setShowPolicyForm] = useState(false)
  const [policyForm, setPolicyForm] = useState({ name: '', description: '', benefits: '', base_premium: '', premium_multiplier: '1.07' })
  const [publishingPolicy, setPublishingPolicy] = useState(false)
  // ── Policy Upgrade Announcement (simulated, localStorage-based) ───────────
  const [upgradeForm, setUpgradeForm] = useState({ title: '', benefits: '', coverage: '' })
  const [showUpgradeForm, setShowUpgradeForm] = useState(false)
  const [upgradeLaunched, setUpgradeLaunched] = useState(false)
  // ── Workers list (for gender display) ────────────────────────────────────
  const [workersList, setWorkersList] = useState([])
  // ── Next-week forecast ────────────────────────────────────────────────────
  const [forecast, setForecast] = useState([])

  useEffect(() => {
    const load = async () => {
      try {
        const [sRes, cRes, fRes, wRes, hRes, pRes] = await Promise.all([
          api.get('/admin/stats'),
          api.get('/admin/claims'),
          api.get('/admin/fraud-alerts'),
          api.get('/admin/analytics/weekly'),
          api.get('/admin/risk-heatmap'),
          api.get('/system/status'),   // public endpoint — same source of truth as worker dashboard
        ])
        setStats(sRes.data)
        setClaims(cRes.data.slice(0, 10))
        setFraudAlerts(fRes.data.slice(0, 5))
        setWeekly(wRes.data.reverse())
        setHeatmap(hRes.data)
        setIsPaused(pRes.data.is_systemic_pause)
        api.get('/admin/stats/insight').then(r => setInsight(r.data.insight)).catch(() => {})
        api.get('/admin/system-health').then(r => setHealth(r.data)).catch(() => {})
        // Payment data in background
        api.get('/payments/admin/summary').then(r => setPaymentSummary(r.data)).catch(() => {})
        api.get('/payments/admin/totals').then(r => setPaymentTotals(r.data)).catch(() => {})
        // Manual claims in background
        api.get('/manual-claims/admin/pending').then(r => setPendingManualClaims(r.data)).catch(() => {})
        api.get('/manual-claims/admin/all').then(r => {
          setApprovedManualClaims((r.data || []).filter(c => c.status === 'approved'))
        }).catch(() => {})
        // Non-payment cases in background
        api.get('/non-payment/admin/pending-health').then(r => setPendingHealthCases(r.data)).catch(() => {})
        api.get('/non-payment/admin/blocked').then(r => setBlockedWorkers(r.data)).catch(() => {})
        // Policy versioning in background
        api.get('/policy-versions/active').then(r => setActiveTemplate(r.data)).catch(() => {})
        api.get('/policy-versions/admin/adoption/summary').then(r => setAdoptionSummary(r.data)).catch(() => {})
        api.get('/policy-versions/admin/adoption').then(r => setAdoptionList(r.data)).catch(() => {})
        // Workers list for gender display
        api.get('/admin/workers').then(r => setWorkersList(r.data)).catch(() => {})
        // Next-week risk forecast
        api.get('/admin/forecast').then(r => setForecast(r.data)).catch(() => {})
      } catch (err) {
        console.error(err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
    </div>
  )

  const lossRatioPct = stats ? stats.loss_ratio.toFixed(1) : 0
  const displayLossRatio = Math.min(parseFloat(lossRatioPct), 300)
  const lossColor = stats?.loss_ratio > 80 ? 'text-red-600' : stats?.loss_ratio > 50 ? 'text-orange-500' : 'text-green-600'

  const handleTogglePause = async () => {
    setPauseToggling(true)
    try {
      const res = await api.post('/admin/toggle-pause')
      setIsPaused(res.data.is_systemic_pause)
    } catch (err) {
      console.error('Failed to toggle systemic pause', err)
    } finally {
      setPauseToggling(false)
    }
  }

  const handlePublishPolicy = async () => {
    if (!policyForm.name.trim() || !policyForm.base_premium) {
      toast.error('Name and base premium are required')
      return
    }
    setPublishingPolicy(true)
    try {
      const r = await api.post('/policy-versions/admin/publish', {
        name: policyForm.name.trim(),
        description: policyForm.description.trim() || undefined,
        benefits: policyForm.benefits.trim() || undefined,
        base_premium: Number(policyForm.base_premium),
        premium_multiplier: Number(policyForm.premium_multiplier) || 1.07,
      })
      setActiveTemplate(r.data)
      setShowPolicyForm(false)
      setPolicyForm({ name: '', description: '', benefits: '', base_premium: '', premium_multiplier: '1.07' })
      toast.success(`Policy v${r.data.version} published! All workers notified.`)
      api.get('/policy-versions/admin/adoption/summary').then(r2 => setAdoptionSummary(r2.data)).catch(() => {})
    } catch (err) {
      toast.error(err.response?.data?.detail ?? 'Publish failed')
    } finally {
      setPublishingPolicy(false)
    }
  }

  const refreshNonPayment = async () => {
    api.get('/non-payment/admin/pending-health').then(r => setPendingHealthCases(r.data)).catch(() => {})
    api.get('/non-payment/admin/blocked').then(r => setBlockedWorkers(r.data)).catch(() => {})
  }

  const handleDocAction = async (caseId, action) => {
    setNpActionLoading(prev => ({ ...prev, [`doc-${caseId}`]: action }))
    try {
      await api.post(`/non-payment/admin/${caseId}/review-document`, { action })
      toast.success(`Document ${action.toLowerCase()}d`)
      refreshNonPayment()
    } catch (err) {
      toast.error(err.response?.data?.detail ?? 'Action failed')
    } finally {
      setNpActionLoading(prev => ({ ...prev, [`doc-${caseId}`]: null }))
    }
  }

  const handleClassify = async (caseId, health_case_type) => {
    setNpActionLoading(prev => ({ ...prev, [`cls-${caseId}`]: health_case_type }))
    try {
      await api.post(`/non-payment/admin/${caseId}/classify`, { health_case_type })
      toast.success(`Case classified as ${health_case_type}`)
      refreshNonPayment()
    } catch (err) {
      toast.error(err.response?.data?.detail ?? 'Classification failed')
    } finally {
      setNpActionLoading(prev => ({ ...prev, [`cls-${caseId}`]: null }))
    }
  }

  const handleBlockSimple = async (workerId) => {
    setNpActionLoading(prev => ({ ...prev, [`blk-${workerId}`]: true }))
    try {
      await api.post(`/non-payment/admin/${workerId}/block-simple`)
      toast.success('Worker blocked for 6 months')
      refreshNonPayment()
    } catch (err) {
      toast.error(err.response?.data?.detail ?? 'Block failed')
    } finally {
      setNpActionLoading(prev => ({ ...prev, [`blk-${workerId}`]: null }))
    }
  }

  const handleLiftBlock = async (workerId) => {
    setNpActionLoading(prev => ({ ...prev, [`lift-${workerId}`]: true }))
    try {
      await api.post(`/non-payment/admin/${workerId}/lift-block`)
      toast.success('Block lifted')
      refreshNonPayment()
    } catch (err) {
      toast.error(err.response?.data?.detail ?? 'Failed to lift block')
    } finally {
      setNpActionLoading(prev => ({ ...prev, [`lift-${workerId}`]: null }))
    }
  }

  const handleClaimAction = async (claimId, action) => {
    setClaimActionLoading(prev => ({ ...prev, [claimId]: action }))
    try {
      await api.post(`/manual-claims/admin/${claimId}/${action}`)
      toast.success(`Claim #${claimId} ${action}d successfully`)
      const [pendingRes, allRes] = await Promise.all([
        api.get('/manual-claims/admin/pending'),
        api.get('/manual-claims/admin/all'),
      ])
      setPendingManualClaims(pendingRes.data)
      setApprovedManualClaims((allRes.data || []).filter(c => c.status === 'approved'))
    } catch (err) {
      toast.error(err.response?.data?.detail ?? `Failed to ${action} claim`)
    } finally {
      setClaimActionLoading(prev => ({ ...prev, [claimId]: null }))
    }
  }

  const handleSimulateNotifications = async () => {
    setSimulating(true)
    try {
      await api.post('/notifications/test')
      toast.success('Simulation triggered — workers will see notifications shortly')
    } catch (err) {
      toast.error('Simulation failed: ' + (err.response?.data?.detail ?? err.message))
    } finally {
      setSimulating(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="text-blue-600" size={28} />
          <div>
            <h1 className="font-bold text-lg">AbhayaRaksha Admin</h1>
            <p className="text-xs text-gray-500">Platform Operations Dashboard</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <NotificationBell />
          <button
            onClick={handleSimulateNotifications}
            disabled={simulating}
            className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white text-sm font-medium px-4 py-2 rounded-lg transition"
          >
            <Bell size={16} /> {simulating ? 'Simulating…' : 'Simulate Notifications'}
          </button>
          <Link to="/simulate" className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-medium px-4 py-2 rounded-lg transition">
            <Zap size={16} /> Run Simulation
          </Link>
          <Link to="/admin/locations" className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition">
            <MapPin size={16} /> Location Monitor
          </Link>
          <Link to="/login" className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2">
            Worker Login →
          </Link>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard icon={Users} label="Total Workers" value={stats.total_workers} color="blue" />
            <StatCard icon={Shield} label="Active Policies" value={stats.active_policies} color="green" sub={`${stats.total_policies} total`} />
            <StatCard icon={Activity} label="Total Claims" value={stats.total_claims} color="orange" sub={`${stats.approved_claims} approved`} />
            <StatCard icon={DollarSign} label="Total Payout" value={`₹${stats.total_payout.toLocaleString()}`} color="purple" />
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-4">
          {/* Loss Ratio */}
          {stats && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <h3 className="text-sm text-gray-500 mb-2">Loss Ratio</h3>
              <p className={`text-4xl font-bold ${lossColor}`}>{lossRatioPct}%</p>
              <p className="text-xs text-gray-400 mt-1">
                {parseFloat(lossRatioPct) > 150
                  ? '🔴 High Risk'
                  : stats.loss_ratio < 50 ? '✅ Healthy' : stats.loss_ratio < 80 ? '⚠️ Monitor' : '🚨 Critical'}
              </p>
              <div className="mt-3 bg-gray-100 rounded-full h-2">
                <div
                  className={`h-2 rounded-full ${stats.loss_ratio < 50 ? 'bg-green-500' : stats.loss_ratio < 80 ? 'bg-orange-400' : 'bg-red-500'}`}
                  style={{ width: `${displayLossRatio}%` }}
                />
              </div>
            </div>
          )}

          {/* Fraud Alerts */}
          {stats && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <h3 className="text-sm text-gray-500 mb-2">Fraud Alerts</h3>
              <p className="text-4xl font-bold text-red-500">{stats.fraud_alerts}</p>
              <p className="text-xs text-gray-400 mt-1">Claims with fraud score ≥ 0.6</p>
              {fraudAlerts.length > 0 && (
                <div className="mt-3 space-y-1">
                  {fraudAlerts.slice(0, 3).map(f => (
                    <div key={f.id} className="text-xs bg-red-50 text-red-700 px-2 py-1 rounded">
                      Claim #{f.id} — score: {f.fraud_score?.toFixed(2)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* AI Insight */}
          <div className="bg-gradient-to-br from-indigo-50 to-blue-50 border border-indigo-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-2">
              <span>🤖</span>
              <span className="text-sm font-semibold text-indigo-700">AI Insight</span>
            </div>
            <p className="text-sm text-gray-700 leading-relaxed">
              {insight || 'Loading AI analysis...'}
            </p>
          </div>
        </div>

        {/* Weekly Analytics Chart */}
        {weekly.length > 0 && (
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-900">Weekly Claims & Payouts</h3>
              <span className="text-xs text-blue-600 bg-blue-50 border border-blue-200 rounded-md px-2 py-1">
                📍 All payouts verified using GPS location and hyperlocal weather triggers
              </span>
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={weekly}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="week" tick={{ fontSize: 12 }} />
                <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Bar yAxisId="left" dataKey="claims" fill="#3b82f6" name="Claims" radius={[4,4,0,0]} />
                <Bar yAxisId="right" dataKey="payout" fill="#10b981" name="Payout (₹)" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Risk Heatmap */}
        {heatmap.length > 0 && (
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <h3 className="font-semibold text-gray-900 mb-4">Risk Heatmap by City</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {heatmap.map(h => {
                const pct = Math.round(h.avg_risk * 100)
                const bg = pct < 30 ? 'bg-green-100 border-green-300' : pct < 60 ? 'bg-yellow-100 border-yellow-300' : 'bg-red-100 border-red-300'
                const text = pct < 30 ? 'text-green-700' : pct < 60 ? 'text-yellow-700' : 'text-red-700'
                return (
                  <div key={h.city} className={`border rounded-lg p-3 ${bg}`}>
                    <p className="text-sm font-medium text-gray-700">{h.city}</p>
                    <p className={`text-2xl font-bold ${text}`}>{pct}%</p>
                    <p className="text-xs text-gray-500">{h.data_points} readings</p>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Next Week Risk Forecast ───────────────────────────────────── */}
        {forecast.length > 0 && (
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-lg">🔮</span>
              <h3 className="font-semibold text-gray-900">Next Week Risk Forecast</h3>
              <span className="ml-auto text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                Predictive · 7-day outlook
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              {forecast.map(f => {
                const isHigh = f.risk === 'High'
                const isMod  = f.risk === 'Moderate'
                const isLow  = f.risk === 'Low'
                const bg     = isHigh ? 'bg-red-50 border-red-200'
                             : isMod  ? 'bg-yellow-50 border-yellow-200'
                             : isLow  ? 'bg-green-50 border-green-200'
                             :          'bg-gray-50 border-gray-200'
                const badge  = isHigh ? 'bg-red-100 text-red-700'
                             : isMod  ? 'bg-yellow-100 text-yellow-700'
                             : isLow  ? 'bg-green-100 text-green-700'
                             :          'bg-gray-100 text-gray-500'
                const icon   = isHigh ? '🔴' : isMod ? '🟡' : isLow ? '🟢' : '⚪'
                return (
                  <div key={f.city} className={`border rounded-xl p-3 ${bg}`}>
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-sm font-semibold text-gray-800">{f.city}</p>
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${badge}`}>
                        {icon} {f.risk}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 leading-snug">{f.reason}</p>
                    {f.source === 'openweather_forecast' && (
                      <p className="text-xs text-gray-300 mt-1.5">
                        Rain: {f.max_rain_mm}mm · Temp: {f.max_temp_c}°C
                      </p>
                    )}
                    {f.source !== 'openweather_forecast' && (
                      <p className="text-xs text-gray-300 mt-1.5">Historical estimate</p>
                    )}
                  </div>
                )
              })}
            </div>
            <p className="text-xs text-gray-300 mt-3 text-right">
              Based on OpenWeather 5-day forecast · Thresholds from parametric engine
            </p>
          </div>
        )}

        {/* Systemic Risk Management */}
        <div className={`rounded-xl border-2 p-5 ${isPaused ? 'bg-red-50 border-red-400' : 'bg-white border-gray-200'}`}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className={`p-2 rounded-lg ${isPaused ? 'bg-red-100' : 'bg-gray-100'}`}>
                <ShieldAlert size={22} className={isPaused ? 'text-red-600' : 'text-gray-500'} />
              </div>
              <div>
                <h3 className="font-bold text-gray-900">Systemic Risk Management</h3>
                <p className="text-xs text-gray-500 mt-0.5 max-w-lg">
                  Enable this <strong>ONLY</strong> during national emergencies (War / Pandemic / Nuclear Hazard)
                  to prevent fund insolvency. This will immediately pause <strong>all</strong> automated
                  parametric payouts platform-wide until manually deactivated.
                </p>
                {isPaused && (
                  <p className="text-xs font-semibold text-red-600 mt-2">
                    🚨 ACTIVE — All parametric payouts are currently suspended.
                  </p>
                )}
              </div>
            </div>
            {/* Toggle switch */}
            <button
              onClick={handleTogglePause}
              disabled={pauseToggling}
              aria-pressed={isPaused}
              className={`relative flex-shrink-0 w-14 h-7 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                isPaused ? 'bg-red-500 focus:ring-red-400' : 'bg-gray-300 focus:ring-gray-400'
              } disabled:opacity-60`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform duration-200 ${
                  isPaused ? 'translate-x-7' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              isPaused ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
            }`}>
              {isPaused ? 'PAUSED — Force Majeure Active' : 'ACTIVE — Normal Operations'}
            </span>
          </div>
        </div>

        {/* Recent Claims Table */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 className="font-semibold text-gray-900">Recent Claims</h3>
            <span className="text-xs text-gray-400">Last 10</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {['ID', 'Worker', 'Trigger', 'Value', 'Payout', 'Fraud Score', 'Status', 'Time (IST)'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {claims.map(c => (
                  <tr key={`${c.claim_type ?? 'p'}-${c.id}`} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-500">#{c.id}</td>
                    <td className="px-4 py-3">{c.worker_name || `Worker #${c.worker_id}`}</td>
                    <td className="px-4 py-3 capitalize">
                      {c.trigger_type === 'manual'
                        ? <span className="text-orange-600 font-medium">Manual Request</span>
                        : c.trigger_type}
                    </td>
                    <td className="px-4 py-3">{c.trigger_type === 'manual' ? '—' : c.trigger_value}</td>
                    <td className="px-4 py-3 font-medium">₹{c.payout_amount?.toLocaleString()}</td>
                    <td className="px-4 py-3">
                      {c.trigger_type === 'manual'
                        ? <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">—</span>
                        : (
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            c.fraud_score >= 0.6 ? 'bg-red-100 text-red-700' :
                            c.fraud_score >= 0.3 ? 'bg-yellow-100 text-yellow-700' :
                            'bg-green-100 text-green-700'
                          }`}>
                            {c.fraud_score?.toFixed(2)}
                          </span>
                        )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        c.status === 'paid' ? 'bg-green-100 text-green-700' :
                        c.status === 'approved' ? 'bg-blue-100 text-blue-700' :
                        c.status === 'rejected' ? 'bg-red-100 text-red-700' :
                        'bg-yellow-100 text-yellow-700'
                      }`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{toIST(c.created_at)}</td>
                  </tr>
                ))}
                {claims.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No claims yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        {/* ── Financial & Actuarial Overview (merged) ───────────────────── */}
        {(health || paymentTotals) && (
          <div className={`rounded-xl border-2 p-5 ${health?.enrollment_suspended ? 'bg-red-50 border-red-400' : 'bg-white border-gray-200'}`}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-green-50 text-green-600">
                  <CreditCard size={18} />
                </div>
                <h3 className="font-bold text-gray-900">Financial &amp; Actuarial Overview</h3>
              </div>
              {health?.enrollment_suspended && (
                <span className="text-xs font-bold bg-red-600 text-white px-3 py-1 rounded-full animate-pulse">
                  🚨 Enrollment Suspended: High Risk
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              {/* Claims Paid */}
              {health && (
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Claims Paid</p>
                  <p className="text-xl font-bold text-gray-900">₹{Math.round(health.total_claims_paid).toLocaleString()}</p>
                </div>
              )}
              {/* Loss Ratio */}
              {health && (
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Loss Ratio</p>
                  <p className={`text-xl font-bold ${health.loss_ratio_pct > 80 ? 'text-red-600' : health.loss_ratio_pct > 50 ? 'text-orange-500' : 'text-green-600'}`}>
                    {Math.min(health.loss_ratio_pct, 300).toFixed(1)}%
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {health.loss_ratio_pct > 150
                      ? '🔴 High Risk'
                      : health.loss_ratio_pct <= 50 ? '✅ Healthy' : health.loss_ratio_pct <= 80 ? '⚠️ Monitor' : '🚨 Critical'}
                  </p>
                </div>
              )}
              {/* BCR */}
              {health && (
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">BCR</p>
                  <p className={`text-xl font-bold ${health.bcr > 0.80 ? 'text-red-600' : health.bcr > 0.50 ? 'text-orange-500' : 'text-green-600'}`}>
                    {Math.min(health.bcr * 100, 300).toFixed(1)}%
                  </p>
                </div>
              )}
              {/* Total Premium Received */}
              {paymentTotals && (
                <div className="bg-green-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Total Premium Received</p>
                  <p className="text-xl font-bold text-green-700">₹{paymentTotals.total_received.toLocaleString()}</p>
                </div>
              )}
              {/* Advance Payments */}
              {paymentTotals && (
                <div className="bg-blue-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Advance Payments</p>
                  <p className="text-xl font-bold text-blue-700">₹{paymentTotals.total_advance.toLocaleString()}</p>
                </div>
              )}
              {/* Workers with Dues */}
              {paymentTotals && (
                <div className="bg-yellow-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500 mb-1">Workers with Dues</p>
                  <p className="text-xl font-bold text-yellow-700">{paymentTotals.pending_workers}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Pending Claim Requests ────────────────────────────────────────── */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 className="font-semibold text-gray-900">Pending Claim Requests</h3>
            <span className="text-xs text-gray-400">{pendingManualClaims.length} pending</span>
          </div>
          {pendingManualClaims.length === 0 ? (
            <div className="px-5 py-8 text-center text-gray-400 text-sm">No pending claim requests</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {['ID', 'Worker', 'Amount', 'Reason', 'Submitted', 'Actions'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {pendingManualClaims.map(c => (
                    <tr key={c.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-500">#{c.id}</td>
                      <td className="px-4 py-3 font-medium">{c.worker_name || `Worker #${c.worker_id}`}</td>
                      <td className="px-4 py-3 font-semibold text-gray-900">₹{c.requested_amount.toLocaleString()}</td>
                      <td className="px-4 py-3 text-gray-500 max-w-xs truncate">{c.reason || '—'}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                        {toIST(c.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleClaimAction(c.id, 'approve')}
                            disabled={!!claimActionLoading[c.id]}
                            className="text-xs bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg font-medium transition"
                          >
                            {claimActionLoading[c.id] === 'approve' ? '…' : 'Approve'}
                          </button>
                          <button
                            onClick={() => handleClaimAction(c.id, 'reject')}
                            disabled={!!claimActionLoading[c.id]}
                            className="text-xs bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg font-medium transition"
                          >
                            {claimActionLoading[c.id] === 'reject' ? '…' : 'Reject'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Approved Claims — Ready to Pay ───────────────────────────────── */}
        {approvedManualClaims.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-blue-200">
            <div className="px-5 py-4 border-b border-blue-100 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">Approved Claims — Ready to Pay</h3>
              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{approvedManualClaims.length} approved</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-blue-50">
                  <tr>
                    {['ID', 'Worker', 'Amount', 'Reason', 'Action'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {approvedManualClaims.map(c => (
                    <tr key={c.id} className="hover:bg-blue-50">
                      <td className="px-4 py-3 text-gray-500">#{c.id}</td>
                      <td className="px-4 py-3 font-medium">{c.worker_name || `Worker #${c.worker_id}`}</td>
                      <td className="px-4 py-3 font-semibold text-gray-900">₹{c.requested_amount.toLocaleString()}</td>
                      <td className="px-4 py-3 text-gray-500">{c.reason || '—'}</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleClaimAction(c.id, 'pay')}
                          disabled={!!claimActionLoading[c.id]}
                          className="text-xs bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg font-medium transition"
                        >
                          {claimActionLoading[c.id] === 'pay' ? 'Processing…' : '💸 Pay Now'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Pending Health Cases ──────────────────────────────────────── */}
        {pendingHealthCases.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-yellow-200">
            <div className="px-5 py-4 border-b border-yellow-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-lg">🩺</span>
                <h3 className="font-semibold text-gray-900">Pending Health Cases</h3>
              </div>
              <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">{pendingHealthCases.length} pending</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-yellow-50">
                  <tr>
                    {['Worker', 'Document', 'Admission Period', 'Submitted', 'Doc Review', 'Classify'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {pendingHealthCases.map(c => (
                    <tr key={c.id} className="hover:bg-yellow-50">
                      <td className="px-4 py-3 font-medium">{c.worker_name || `Worker #${c.worker_id}`}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs max-w-xs">
                        <div className="flex flex-col gap-1">
                          <span className="truncate">{c.document_filename || '—'}</span>
                          {c.document_filename && (
                            <a
                              href={`/api/non-payment/admin/document/${encodeURIComponent(c.document_filename)}?token=${localStorage.getItem('token')}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline font-medium text-xs"
                            >
                              📄 View Document
                            </a>
                          )}
                        </div>
                        <span className={`mt-1 inline-block px-1.5 py-0.5 rounded-full text-xs font-medium ${
                          c.document_status === 'APPROVED' ? 'bg-green-100 text-green-700' :
                          c.document_status === 'REJECTED' ? 'bg-red-100 text-red-700' :
                          'bg-yellow-100 text-yellow-700'
                        }`}>
                          {c.document_status || 'PENDING'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {c.admission_from && c.admission_to ? (
                          <>
                            {new Date(c.admission_from.endsWith('Z') ? c.admission_from : c.admission_from + 'Z').toLocaleDateString('en-IN')}
                            {' → '}
                            {new Date(c.admission_to.endsWith('Z') ? c.admission_to : c.admission_to + 'Z').toLocaleDateString('en-IN')}
                          </>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{toIST(c.created_at)}</td>
                      <td className="px-4 py-3">
                        {(!c.document_status || c.document_status === 'PENDING') && (
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleDocAction(c.id, 'APPROVE')}
                              disabled={!!npActionLoading[`doc-${c.id}`]}
                              className="text-xs bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-2 py-1 rounded font-medium"
                            >
                              {npActionLoading[`doc-${c.id}`] === 'APPROVE' ? '…' : 'Approve'}
                            </button>
                            <button
                              onClick={() => handleDocAction(c.id, 'REJECT')}
                              disabled={!!npActionLoading[`doc-${c.id}`]}
                              className="text-xs bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white px-2 py-1 rounded font-medium"
                            >
                              {npActionLoading[`doc-${c.id}`] === 'REJECT' ? '…' : 'Reject'}
                            </button>
                          </div>
                        )}
                        {c.document_status === 'APPROVED' && (
                          <span className="text-xs text-green-600 font-medium">✓ Approved</span>
                        )}
                        {c.document_status === 'REJECTED' && (
                          <span className="text-xs text-red-500">Rejected</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {c.health_case_type ? (
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            c.health_case_type === 'MINOR' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                          }`}>
                            {c.health_case_type}
                          </span>
                        ) : c.document_status === 'APPROVED' ? (
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleClassify(c.id, 'MINOR')}
                              disabled={!!npActionLoading[`cls-${c.id}`]}
                              className="text-xs bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white px-2 py-1 rounded font-medium"
                            >
                              {npActionLoading[`cls-${c.id}`] === 'MINOR' ? '…' : 'Minor'}
                            </button>
                            <button
                              onClick={() => handleClassify(c.id, 'MAJOR')}
                              disabled={!!npActionLoading[`cls-${c.id}`]}
                              className="text-xs bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white px-2 py-1 rounded font-medium"
                            >
                              {npActionLoading[`cls-${c.id}`] === 'MAJOR' ? '…' : 'Major'}
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">Approve doc first</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Blocked Workers ───────────────────────────────────────────────── */}
        {blockedWorkers.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-red-200">
            <div className="px-5 py-4 border-b border-red-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-lg">🚫</span>
                <h3 className="font-semibold text-gray-900">Blocked Workers</h3>
              </div>
              <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{blockedWorkers.length} blocked</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-red-50">
                  <tr>
                    {['Worker', 'Reason', 'Blocked Until', 'Action'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {blockedWorkers.map(c => (
                    <tr key={c.id} className="hover:bg-red-50">
                      <td className="px-4 py-3 font-medium">{c.worker_name || `Worker #${c.worker_id}`}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                          {c.non_payment_reason || 'SIMPLE'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {c.block_until ? new Date(
                          c.block_until.endsWith('Z') ? c.block_until : c.block_until + 'Z'
                        ).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => handleLiftBlock(c.worker_id)}
                          disabled={!!npActionLoading[`lift-${c.worker_id}`]}
                          className="text-xs bg-gray-700 hover:bg-gray-800 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg font-medium"
                        >
                          {npActionLoading[`lift-${c.worker_id}`] ? '…' : 'Lift Block'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Policy Management ─────────────────────────────────────────── */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg">📋</span>
              <h3 className="font-semibold text-gray-900">Policy Management</h3>
              {activeTemplate && (
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                  Active: v{activeTemplate.version} — {activeTemplate.name}
                </span>
              )}
            </div>
            <button
              onClick={() => setShowPolicyForm(prev => !prev)}
              className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-medium px-3 py-1.5 rounded-lg transition"
            >
              {showPolicyForm ? 'Cancel' : '+ Publish New Version'}
            </button>
          </div>

          {/* Publish form */}
          {showPolicyForm && (
            <div className="px-5 py-4 border-b border-gray-100 bg-blue-50 space-y-3">
              <p className="text-xs text-blue-700 font-medium">
                Publishing a new version will notify all workers and ask them to choose.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Policy Name *</label>
                  <input
                    type="text"
                    placeholder="e.g. Enhanced Coverage 2026"
                    value={policyForm.name}
                    onChange={e => setPolicyForm(p => ({ ...p, name: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Base Premium (₹/week) *</label>
                  <input
                    type="number"
                    placeholder="e.g. 50"
                    value={policyForm.base_premium}
                    onChange={e => setPolicyForm(p => ({ ...p, base_premium: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Description</label>
                <input
                  type="text"
                  placeholder="Brief description of this policy version"
                  value={policyForm.description}
                  onChange={e => setPolicyForm(p => ({ ...p, description: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Benefits (one per line — shown to workers)</label>
                <textarea
                  rows={3}
                  placeholder={"Higher coverage amount\nFaster claim processing\nExtended AQI protection"}
                  value={policyForm.benefits}
                  onChange={e => setPolicyForm(p => ({ ...p, benefits: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="text-xs text-gray-500 mb-1 block">Premium Multiplier (e.g. 1.07 = +7%)</label>
                  <input
                    type="number"
                    step="0.01"
                    min="1.0"
                    max="2.0"
                    value={policyForm.premium_multiplier}
                    onChange={e => setPolicyForm(p => ({ ...p, premium_multiplier: e.target.value }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    onClick={handlePublishPolicy}
                    disabled={publishingPolicy}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-5 py-2 rounded-lg text-sm transition"
                  >
                    {publishingPolicy ? 'Publishing…' : 'Publish & Notify All'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Adoption summary */}
          {adoptionSummary && adoptionSummary.version && (
            <div className="px-5 py-4">
              <p className="text-xs font-medium text-gray-500 mb-3">
                Adoption for v{adoptionSummary.version} — {adoptionSummary.name}
              </p>
              <div className="grid grid-cols-4 gap-3 mb-4">
                <div className="bg-green-50 rounded-lg p-3 text-center">
                  <p className="text-xl font-bold text-green-700">{adoptionSummary.new_count}</p>
                  <p className="text-xs text-gray-500">Switched to New</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <p className="text-xl font-bold text-gray-700">{adoptionSummary.existing_count}</p>
                  <p className="text-xs text-gray-500">Kept Existing</p>
                </div>
                <div className="bg-yellow-50 rounded-lg p-3 text-center">
                  <p className="text-xl font-bold text-yellow-700">{adoptionSummary.no_choice}</p>
                  <p className="text-xs text-gray-500">No Choice Yet</p>
                </div>
                <div className="bg-red-50 rounded-lg p-3 text-center">
                  <p className="text-xl font-bold text-red-700">{adoptionSummary.irregular_count}</p>
                  <p className="text-xs text-gray-500">Irregular</p>
                </div>
              </div>

              {/* Per-worker adoption list */}
              {adoptionList.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        {['Worker', 'Choice', 'Adjusted Premium', 'Irregular', 'Missed Weeks', 'Tracking Ends'].map(h => (
                          <th key={h} className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {adoptionList.map(a => (
                        <tr key={a.worker_id} className="hover:bg-gray-50">
                          <td className="px-3 py-2 font-medium text-gray-900">{a.worker_name || `Worker #${a.worker_id}`}</td>
                          <td className="px-3 py-2">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              a.choice === 'NEW' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                            }`}>
                              {a.choice}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-gray-700">
                            {a.adjusted_premium ? `₹${a.adjusted_premium.toLocaleString()}` : '—'}
                          </td>
                          <td className="px-3 py-2">
                            {a.is_irregular
                              ? <span className="text-xs text-red-600 font-medium">⚠️ Yes</span>
                              : <span className="text-xs text-green-600">✓ No</span>}
                          </td>
                          <td className="px-3 py-2 text-gray-500">{a.irregular_count}</td>
                          <td className="px-3 py-2 text-gray-400 text-xs">
                            {a.tracking_end ? new Date(
                              a.tracking_end.endsWith('Z') ? a.tracking_end : a.tracking_end + 'Z'
                            ).toLocaleDateString('en-IN') : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Worker Payment Tracking Table ─────────────────────────────────── */}
        {paymentSummary.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-100">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">Worker Payment Tracking</h3>
              <span className="text-xs text-gray-400">{paymentSummary.length} workers</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {['Worker', 'City', 'This Week', 'Due Amount', 'Advance', 'Behaviour', 'Total Paid', 'Action'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {paymentSummary.map(w => (
                    <tr key={w.worker_id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">
                        <div className="flex items-center gap-1.5">
                          {w.worker_name}
                          {workersList.find(wl => wl.id === w.worker_id)?.women_benefits && (
                            <span className="text-xs bg-pink-100 text-pink-600 px-1.5 py-0.5 rounded-full font-medium">🌸</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-500">{w.city}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          w.current_week_status === 'PAID'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-yellow-100 text-yellow-700'
                        }`}>
                          {w.current_week_status === 'PAID' ? '✓ Paid' : '⏳ Pending'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {w.due_amount > 0
                          ? <span className="text-red-600 font-medium">₹{w.due_amount.toLocaleString()}</span>
                          : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        {w.advance_count > 0
                          ? <span className="text-blue-600 font-medium">{w.advance_count} wk{w.advance_count > 1 ? 's' : ''}</span>
                          : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          w.behaviour === 'GOOD'      ? 'bg-green-100 text-green-700' :
                          w.behaviour === 'DELAYED'   ? 'bg-yellow-100 text-yellow-700' :
                                                        'bg-red-100 text-red-700'
                        }`}>
                          {w.behaviour}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-700">₹{w.total_paid.toLocaleString()}</td>
                      <td className="px-4 py-3">
                        {w.due_amount > 0 && (
                          <button
                            onClick={() => handleBlockSimple(w.worker_id)}
                            disabled={!!npActionLoading[`blk-${w.worker_id}`]}
                            className="text-xs bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white px-2 py-1 rounded font-medium"
                            title="Block for simple non-payment"
                          >
                            {npActionLoading[`blk-${w.worker_id}`] ? '…' : 'Block'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {/* ── Policy Upgrade Announcement ──────────────────────────── */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg">🚀</span>
              <h3 className="font-semibold text-gray-900">Launch Policy Upgrade</h3>
            </div>
            <button
              onClick={() => setShowUpgradeForm(p => !p)}
              className="text-xs bg-blue-600 hover:bg-blue-700 text-white font-medium px-3 py-1.5 rounded-lg transition"
            >
              {showUpgradeForm ? 'Cancel' : 'New Upgrade'}
            </button>
          </div>
          {showUpgradeForm && (
            <div className="px-5 py-4 space-y-3">
              <p className="text-xs text-blue-700 bg-blue-50 rounded-lg px-3 py-2">
                This will broadcast an upgrade offer to all workers on their dashboard.
              </p>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Upgrade Title *</label>
                <input
                  type="text"
                  placeholder="e.g. Enhanced Protection Plan 2026"
                  value={upgradeForm.title}
                  onChange={e => setUpgradeForm(p => ({ ...p, title: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Benefits (one per line — shown to workers)</label>
                <textarea
                  rows={3}
                  placeholder={"Higher coverage amount\nFaster claim processing\nExtended AQI protection"}
                  value={upgradeForm.benefits}
                  onChange={e => setUpgradeForm(p => ({ ...p, benefits: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 mb-1 block">New Coverage Amount (₹) *</label>
                <input
                  type="number"
                  placeholder="e.g. 5000"
                  value={upgradeForm.coverage}
                  onChange={e => setUpgradeForm(p => ({ ...p, coverage: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                />
              </div>
              <button
                onClick={() => {
                  if (!upgradeForm.title.trim() || !upgradeForm.coverage) {
                    toast.error('Title and coverage amount are required')
                    return
                  }
                  const offer = {
                    type: 'policy_upgrade',
                    title: upgradeForm.title.trim(),
                    message: upgradeForm.benefits.trim(),
                    coverage: Number(upgradeForm.coverage),
                    launchedAt: new Date().toISOString(),
                  }
                  localStorage.setItem('abhaya_upgrade_offer', JSON.stringify(offer))
                  setUpgradeLaunched(true)
                  setShowUpgradeForm(false)
                  setUpgradeForm({ title: '', benefits: '', coverage: '' })
                  toast.success('Upgrade offer launched! Workers will see it on their dashboard.')
                }}
                className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2 rounded-lg text-sm transition"
              >
                🚀 Launch Upgrade Offer
              </button>
            </div>
          )}
          {upgradeLaunched && !showUpgradeForm && (
            <div className="px-5 py-3 flex items-center justify-between">
              <p className="text-xs text-green-700">✅ Upgrade offer is live on worker dashboards.</p>
              <button
                onClick={() => {
                  localStorage.removeItem('abhaya_upgrade_offer')
                  setUpgradeLaunched(false)
                  toast.success('Upgrade offer withdrawn.')
                }}
                className="text-xs text-red-500 hover:text-red-700 underline"
              >
                Withdraw Offer
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

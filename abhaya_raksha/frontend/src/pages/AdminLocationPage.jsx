/**
 * AdminLocationPage — /admin/locations
 * Shows all workers with city-based geofence status + interactive map.
 * Does NOT modify AdminDashboard.jsx.
 */
import { useState, useEffect, useCallback, useRef, memo } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'
import { Shield, MapPin, RefreshCw, ArrowLeft, AlertTriangle } from 'lucide-react'
import { MapContainer, TileLayer, Circle, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Fix Leaflet default icon paths broken by Vite
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

function makeIcon(color) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width:16px;height:16px;border-radius:50%;
      background:${color};border:2.5px solid white;
      box-shadow:0 1px 5px rgba(0,0,0,.45)">
    </div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  })
}

// Pre-create icons once at module level — avoids new L.divIcon() on every render
const ICON_GREEN = makeIcon('#22c55e')
const ICON_RED   = makeIcon('#ef4444')

function toIST(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
}

function StatusBadge({ status }) {
  if (status === 'INSIDE')
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">✔ Inside Zone</span>
  if (status === 'OUTSIDE')
    return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">⚠ Outside Zone</span>
  return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-500">No Data</span>
}

// Memoized — only re-renders when the worker's position, status, or identity changes.
// Prevents Leaflet from reinitialising on every poll tick.
const WorkerMap = memo(function WorkerMap({ worker }) {
  if (!worker.latitude || !worker.longitude || !worker.zone_center) {
    return (
      <div className="h-64 flex items-center justify-center text-gray-400 text-sm bg-gray-50 rounded-xl border border-gray-200">
        No location data available for this worker.
      </div>
    )
  }

  const center = [worker.zone_center[0], worker.zone_center[1]]
  const markerPos = [worker.latitude, worker.longitude]
  const inside = worker.status === 'INSIDE'

  return (
    <MapContainer
      key={worker.id}
      center={center}
      zoom={12}
      style={{ height: '320px', width: '100%', borderRadius: '0.75rem' }}
      scrollWheelZoom={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {/* Zone circle — radius reflects hyperlocal (1.5 km) or city-level (5 km) */}
      <Circle
        center={center}
        radius={(worker.radius_km ?? 5) * 1000}
        pathOptions={{ color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.12, weight: 2 }}
      />
      {/* Worker marker */}
      <Marker position={markerPos} icon={inside ? ICON_GREEN : ICON_RED}>
        <Popup>
          <div className="text-sm space-y-1 min-w-[160px]">
            <p className="font-semibold">{worker.name}</p>
            <p className="text-gray-500 text-xs">{worker.city}</p>
            <p className="text-xs text-gray-500">
              {worker.latitude.toFixed(5)}, {worker.longitude.toFixed(5)}
            </p>
            <p>Distance: <span className="font-medium">{worker.distance != null ? `${worker.distance} km` : '—'}</span></p>
            <p>
              Status:{' '}
              <span className={`font-semibold ${inside ? 'text-green-600' : 'text-red-600'}`}>
                {inside ? '✔ Inside Zone' : '⚠ Outside Zone'}
              </span>
            </p>
            <p className="text-gray-400 text-xs">Updated: {toIST(worker.last_location_update)}</p>
          </div>
        </Popup>
      </Marker>
    </MapContainer>
  )
}, (prev, next) =>
  prev.worker.id        === next.worker.id &&
  prev.worker.latitude  === next.worker.latitude &&
  prev.worker.longitude === next.worker.longitude &&
  prev.worker.status    === next.worker.status &&
  prev.worker.radius_km === next.worker.radius_km
)

export default function AdminLocationPage() {
  const [workers, setWorkers] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedWorker, setSelectedWorker] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  // Ref keeps fetchLocations stable (empty useCallback deps) while still
  // reading the latest selectedWorker without a stale closure.
  const selectedWorkerRef = useRef(null)
  useEffect(() => {
    selectedWorkerRef.current = selectedWorker
  }, [selectedWorker])

  const fetchLocations = useCallback(async () => {
    try {
      const res = await api.get('/workers/location-status')
      setWorkers(res.data)
      setLastRefresh(new Date())
      // Sync selected worker using ref — avoids stale closure and interval loop
      const current = selectedWorkerRef.current
      if (current) {
        const updated = res.data.find(w => w.id === current.id)
        if (updated) setSelectedWorker(updated)
      }
    } catch (err) {
      console.error('Failed to fetch worker locations', err)
    } finally {
      setLoading(false)
    }
  }, [])   // stable — never recreated, interval never torn down mid-session

  // Initial load + 10-second auto-refresh (interval created once, cleaned up on unmount)
  useEffect(() => {
    fetchLocations()
    const interval = setInterval(fetchLocations, 10000)
    return () => clearInterval(interval)
  }, [fetchLocations])

  const insideCount  = workers.filter(w => w.status === 'INSIDE').length
  const outsideCount = workers.filter(w => w.status === 'OUTSIDE').length
  const noDataCount  = workers.filter(w => w.status === 'NO_DATA' || w.status === 'UNKNOWN').length
  const fraudCount   = workers.filter(w => w.fraud_flag === 'OUT_OF_ZONE').length

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="text-blue-600" size={28} />
          <div>
            <h1 className="font-bold text-lg">Worker Location Monitoring</h1>
            <p className="text-xs text-gray-500">Hyperlocal zones (1.5 km) · City fallback (5 km)</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-xs text-gray-400">
              Updated {lastRefresh.toLocaleTimeString('en-IN')}
            </span>
          )}
          <button
            onClick={fetchLocations}
            className="p-2 hover:bg-gray-100 rounded-lg transition"
            title="Refresh"
          >
            <RefreshCw size={16} className="text-gray-500" />
          </button>
          <Link
            to="/admin"
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-blue-600 transition"
          >
            <ArrowLeft size={15} /> Back to Dashboard
          </Link>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 flex items-center gap-3">
            <div className="p-2 bg-green-50 rounded-lg"><MapPin size={18} className="text-green-600" /></div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{insideCount}</p>
              <p className="text-xs text-gray-500">Inside Zone</p>
            </div>
          </div>
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 flex items-center gap-3">
            <div className="p-2 bg-red-50 rounded-lg"><MapPin size={18} className="text-red-500" /></div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{outsideCount}</p>
              <p className="text-xs text-gray-500">Outside Zone</p>
            </div>
          </div>
          <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 flex items-center gap-3">
            <div className="p-2 bg-gray-100 rounded-lg"><MapPin size={18} className="text-gray-400" /></div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{noDataCount}</p>
              <p className="text-xs text-gray-500">No GPS Data</p>
            </div>
          </div>
          <div className={`rounded-xl p-4 shadow-sm border flex items-center gap-3 ${
            fraudCount > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-100'
          }`}>
            <div className={`p-2 rounded-lg ${fraudCount > 0 ? 'bg-red-100' : 'bg-gray-100'}`}>
              <AlertTriangle size={18} className={fraudCount > 0 ? 'text-red-600' : 'text-gray-400'} />
            </div>
            <div>
              <p className={`text-2xl font-bold ${fraudCount > 0 ? 'text-red-600' : 'text-gray-900'}`}>
                {fraudCount}
              </p>
              <p className="text-xs text-gray-500">Fraud Alerts</p>
            </div>
          </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Worker table */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100">
            <div className="px-5 py-4 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">All Workers</h2>
            </div>

            {loading ? (
              <div className="p-8 flex justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
              </div>
            ) : workers.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">No workers found.</div>
            ) : (
              <div className="divide-y divide-gray-50">
                {workers.map(w => (
                  <div
                    key={w.id}
                    className={`px-5 py-3 flex items-center justify-between hover:bg-gray-50 transition cursor-pointer ${
                      selectedWorker?.id === w.id ? 'bg-blue-50' : ''
                    }`}
                    onClick={() => setSelectedWorker(w)}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{w.name}</p>
                      <p className="text-xs text-gray-400">
                        {w.city}
                        {w.zone_name && (
                          <span className="ml-1 text-blue-500">· {w.zone_name}</span>
                        )}
                      </p>
                      {w.status === 'OUTSIDE' && (
                        <p className="text-xs text-red-500 mt-0.5">⚠ Outside assigned delivery zone</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                      {w.distance != null && (
                        <span className="text-xs text-gray-500">{w.distance} km</span>
                      )}
                      <StatusBadge status={w.status} />
                      {w.fraud_flag === 'OUT_OF_ZONE' && (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-600 text-white">
                          <AlertTriangle size={10} /> Fraud Risk
                        </span>
                      )}
                      <span className="text-xs text-gray-400 hidden sm:block">
                        {toIST(w.last_location_update)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Map panel */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">
                {selectedWorker ? `${selectedWorker.name} — ${selectedWorker.city}` : 'Select a worker to view map'}
              </h2>
              {selectedWorker && (
                <div className="flex items-center gap-2">
                  <StatusBadge status={selectedWorker.status} />
                  {selectedWorker.fraud_flag === 'OUT_OF_ZONE' && (
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-600 text-white">
                      <AlertTriangle size={10} /> Fraud Risk
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="p-4">
              {selectedWorker ? (
                <WorkerMap worker={selectedWorker} />
              ) : (
                <div className="h-64 flex flex-col items-center justify-center text-gray-400 gap-2">
                  <MapPin size={32} className="opacity-30" />
                  <p className="text-sm">Click a worker in the table to view their location on the map.</p>
                </div>
              )}
            </div>
            {selectedWorker && (
              <div className="px-5 pb-4 grid grid-cols-2 gap-3 text-sm">
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 mb-0.5">Coordinates</p>
                  <p className="font-medium text-gray-800">
                    {selectedWorker.latitude != null
                      ? `${selectedWorker.latitude.toFixed(5)}, ${selectedWorker.longitude.toFixed(5)}`
                      : '—'}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 mb-0.5">Distance from zone centre</p>
                  <p className="font-medium text-gray-800">
                    {selectedWorker.distance != null ? `${selectedWorker.distance} km` : '—'}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 mb-0.5">Zone</p>
                  <p className="font-medium text-gray-800">
                    {selectedWorker.zone_name
                      ? <span className="text-blue-600">{selectedWorker.zone_name}</span>
                      : <span className="text-gray-400">Not Assigned</span>}
                  </p>
                  {selectedWorker.radius_km != null && (
                    <p className="text-xs text-gray-400 mt-0.5">Radius: {selectedWorker.radius_km} km</p>
                  )}
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 mb-0.5">Last GPS update (IST)</p>
                  <p className="font-medium text-gray-800">{toIST(selectedWorker.last_location_update)}</p>
                </div>
                {selectedWorker.status === 'OUTSIDE' && (
                  <div className="col-span-2 bg-red-50 border border-red-200 rounded-lg p-3">
                    <p className="text-xs font-semibold text-red-600">
                      ⚠ Outside assigned delivery zone
                    </p>
                    <p className="text-xs text-red-400 mt-0.5">
                      Worker is {selectedWorker.distance != null ? `${selectedWorker.distance} km` : 'an unknown distance'} from the zone centre — exceeds the {selectedWorker.radius_km ?? '—'} km limit.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

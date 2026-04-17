import { useState, useEffect } from 'react'
import { CheckCircle, X, Loader2, Banknote, RefreshCw } from 'lucide-react'
import api from '../api'

/**
 * WithdrawModal — 3-step payout flow backed by Razorpay Orders API.
 *
 * Steps:
 *   confirm    → user reviews payout details and clicks "Confirm Transfer"
 *   processing → real API call in progress (no fake delays)
 *   success    → shows real Razorpay order_id from response.transaction_id
 *   error      → shows error message with Retry option
 *
 * Props:
 *   claim    — claim object { id, payout_amount, trigger_type }
 *   onClose  — called on dismiss; receives true if withdrawal succeeded
 */
export default function WithdrawModal({ claim, onClose }) {
  const [phase, setPhase] = useState('confirm')   // confirm | processing | success | error
  const [txnId, setTxnId] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  // Lock body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const handleConfirm = async () => {
    setPhase('processing')
    setErrorMsg('')
    try {
      const res = await api.post(`/claims/${claim.id}/withdraw`)
      // Use the real Razorpay order_id returned by the backend
      setTxnId(res.data.transaction_id)
      setPhase('success')
    } catch (err) {
      setErrorMsg(
        err.response?.data?.detail ||
        'Payment gateway error. Please try again.'
      )
      setPhase('error')
    }
  }

  const handleClose = () => {
    onClose(phase === 'success')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget && phase !== 'processing') handleClose() }}
    >
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">

        {/* Close button — hidden while API call is in flight */}
        {phase !== 'processing' && (
          <button
            onClick={handleClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        )}

        {/* ── Step 1: Confirm ───────────────────────────────────────── */}
        {phase === 'confirm' && (
          <div className="p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-green-50 rounded-xl">
                <Banknote className="text-green-600" size={24} />
              </div>
              <div>
                <h2 className="font-bold text-gray-900 text-lg">Withdraw to UPI</h2>
                <p className="text-xs text-gray-500 capitalize">
                  {claim.trigger_type} disruption payout
                </p>
              </div>
            </div>

            {/* Payout summary */}
            <div className="bg-gray-50 rounded-xl p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Payout amount</span>
                <span className="font-bold text-gray-900">
                  ₹{claim.payout_amount.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Method</span>
                <span className="text-gray-700">UPI / Bank Transfer</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Processing time</span>
                <span className="text-green-600 font-medium">Instant</span>
              </div>
            </div>

            <p className="text-xs text-gray-400 text-center">
              This payout has been approved. Confirming will initiate the transfer
              via Razorpay to your linked UPI account.
            </p>

            {/* Step progress indicator */}
            <div className="flex items-center justify-center gap-2 text-xs">
              <span className="px-2 py-0.5 rounded-full font-medium bg-green-100 text-green-700">
                1 Confirm
              </span>
              <span className="text-gray-300">→</span>
              <span className="px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-400">
                2 Process
              </span>
              <span className="text-gray-300">→</span>
              <span className="px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-400">
                3 Done
              </span>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleClose}
                className="flex-1 border border-gray-200 text-gray-600 text-sm font-medium py-2.5 rounded-xl hover:bg-gray-50 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold py-2.5 rounded-xl transition"
              >
                Confirm Transfer
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2: Processing (real API call, no fake delays) ────── */}
        {phase === 'processing' && (
          <div className="p-10 flex flex-col items-center gap-5">
            <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center">
              <Loader2 className="text-green-600 animate-spin" size={32} />
            </div>
            <div className="text-center space-y-1">
              <p className="font-semibold text-gray-900">
                Connecting to payment gateway...
              </p>
              <p className="text-xs text-gray-400">Processing your payout</p>
              <p className="text-xs text-gray-300 mt-1">Please do not close this window</p>
            </div>

            {/* Step progress indicator */}
            <div className="flex items-center gap-2 text-xs">
              <span className="px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-400">
                1 Confirm
              </span>
              <span className="text-gray-300">→</span>
              <span className="px-2 py-0.5 rounded-full font-medium bg-green-100 text-green-700">
                2 Process
              </span>
              <span className="text-gray-300">→</span>
              <span className="px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-400">
                3 Done
              </span>
            </div>
          </div>
        )}

        {/* ── Step 3: Success ───────────────────────────────────────── */}
        {phase === 'success' && (
          <div className="p-8 flex flex-col items-center gap-4 text-center">
            <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle className="text-green-500" size={44} strokeWidth={1.5} />
            </div>

            <div className="space-y-1">
              <h2 className="text-xl font-bold text-gray-900">Transfer Successful!</h2>
              <p className="text-sm text-gray-500">
                ₹{claim.payout_amount.toLocaleString()} sent to your UPI account
              </p>
            </div>

            {/* Transaction details — transaction_id is the real Razorpay order_id */}
            <div className="w-full bg-green-50 border border-green-200 rounded-xl p-4 space-y-2 text-sm">
              <div className="flex justify-between items-start gap-2">
                <span className="text-gray-500 flex-shrink-0">Transaction ID</span>
                <span className="font-mono font-semibold text-green-700 text-right break-all">
                  {txnId}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Amount</span>
                <span className="font-bold text-gray-900">
                  ₹{claim.payout_amount.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Status</span>
                <span className="text-green-600 font-medium">Paid</span>
              </div>
            </div>

            {/* Step progress indicator */}
            <div className="flex items-center gap-2 text-xs">
              <span className="px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-400">
                1 Confirm
              </span>
              <span className="text-gray-300">→</span>
              <span className="px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-400">
                2 Process
              </span>
              <span className="text-gray-300">→</span>
              <span className="px-2 py-0.5 rounded-full font-medium bg-green-100 text-green-700">
                3 Done
              </span>
            </div>

            <button
              onClick={handleClose}
              className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2.5 rounded-xl transition"
            >
              Done
            </button>

            {/* Razorpay attribution */}
            <p className="text-xs text-gray-300">Powered by Razorpay (Test Mode)</p>
          </div>
        )}

        {/* ── Error ─────────────────────────────────────────────────── */}
        {phase === 'error' && (
          <div className="p-8 flex flex-col items-center gap-4 text-center">
            <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">
              <X className="text-red-500" size={32} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Transfer Failed</h2>
              <p className="text-sm text-gray-500 mt-1">{errorMsg}</p>
            </div>
            <div className="flex gap-3 w-full">
              <button
                onClick={handleClose}
                className="flex-1 border border-gray-200 text-gray-600 text-sm font-medium py-2.5 rounded-xl hover:bg-gray-50 transition"
              >
                Close
              </button>
              <button
                onClick={handleConfirm}
                className="flex-1 flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold py-2.5 rounded-xl transition"
              >
                <RefreshCw size={14} /> Retry
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

/**
 * Footer — appears on all pages.
 * Contains regulatory disclaimers, quick links, and hackathon context.
 * UI-only component — no API calls, no state.
 */
export default function Footer() {
  return (
    <footer className="bg-gray-900 text-gray-300 text-sm py-6 px-4 mt-auto">
      <div className="max-w-6xl mx-auto space-y-4">

        {/* Top row — brand + quick links */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <p className="font-semibold text-white text-base">AbhayaRaksha</p>
            <p className="text-gray-400 text-xs mt-0.5">
              Parametric Income Protection for Gig Workers
            </p>
          </div>
          <nav className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-400">
            <a href="#" className="hover:text-white transition">Terms of Use</a>
            <a href="#" className="hover:text-white transition">Privacy Policy</a>
            <a href="#" className="hover:text-white transition">Grievance Policy</a>
            <a href="#" className="hover:text-white transition">Contact</a>
          </nav>
        </div>

        {/* Divider */}
        <div className="border-t border-gray-700" />

        {/* Disclaimer rows */}
        <div className="space-y-1.5 text-xs text-gray-400">
          <p>
            This is a parametric insurance prototype built for demonstration purposes.
            Payouts are triggered automatically based on verified environmental conditions.
          </p>
          <p>Insurance is the subject matter of solicitation.</p>
          <p>We do not make unsolicited calls requesting payments or benefits.</p>
          <p className="text-gray-500">
            ⚠ This platform is a hackathon prototype and not a licensed insurance product.
            Built for Guidewire DEVTrails 2026.
          </p>
        </div>

      </div>
    </footer>
  )
}

import { redirect } from 'next/navigation'

// /sales-dashboard root → always route to the Funnel/Pulse page. The
// old curated-overview "Pulse" was removed when Funnel became the
// canonical activity view.

export default function SalesDashboardRootRedirect() {
  redirect('/sales-dashboard/funnel')
}

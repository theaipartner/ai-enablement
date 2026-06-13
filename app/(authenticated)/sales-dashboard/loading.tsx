import { GenericSalesSkeleton } from '@/components/sales/page-skeleton'
// Catch-all skeleton for sales routes without their own loading.tsx
// (ads, landing-pages, revival, [section], …).
export default function Loading() {
  return <GenericSalesSkeleton />
}

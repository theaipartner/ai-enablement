import Link from 'next/link'

export default function ClientNotFound() {
  return (
    <div className="p-12 max-w-2xl mx-auto text-center space-y-3">
      <h1 className="text-2xl font-semibold">Client not found</h1>
      <p className="text-sm text-muted-foreground">
        This client may have been archived or the link is wrong.
      </p>
      <Link
        href="/clients"
        className="inline-block text-sm text-primary hover:underline underline-offset-4"
      >
        ← Back to Clients
      </Link>
    </div>
  )
}

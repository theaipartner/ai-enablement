import { redirect } from 'next/navigation'

export default function ContentRootRedirect() {
  redirect('/content/dashboard')
}

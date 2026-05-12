import { Instrument_Serif, Inter } from 'next/font/google'

export const prometheanSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  variable: '--font-prom-serif',
  display: 'swap',
})

export const prometheanSans = Inter({
  subsets: ['latin'],
  variable: '--font-prom-sans',
  display: 'swap',
})

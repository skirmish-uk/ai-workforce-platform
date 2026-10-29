import { redirect } from 'next/navigation'
import { getServerSession } from 'next-auth'
import { authOptions } from '@ai-workforce/auth'
import Link from 'next/link'

export default async function HomePage() {
  const session = await getServerSession(authOptions)

  if (session) {
    redirect('/dashboard')
  }

  return (
    <main className="min-h-screen flex flex-col">
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-8 h-8 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
            </svg>
            <span className="text-xl font-bold text-neutral-900 dark:text-neutral-50">AI Workforce</span>
          </div>
          <nav className="flex items-center gap-4">
            <Link href="/demo" className="text-sm font-medium text-primary-600 hover:text-primary-700">
              Demo
            </Link>
            <Link href="/auth/signin" className="text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100">
              Sign in
            </Link>
            <Link href="/auth/signin" className="px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors">
              Get Started
            </Link>
          </nav>
        </div>
      </header>

      <section className="flex-1 flex items-center justify-center px-4 py-20">
        <div className="max-w-3xl text-center">
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50 mb-6">
            Your AI Employee,{' '}
            <span className="text-primary-600">Tailored to Your Business</span>
          </h1>
          <p className="text-lg sm:text-xl text-neutral-600 dark:text-neutral-400 mb-10 max-w-2xl mx-auto">
            We deploy and manage a customised AI employee that knows your business, connects to your systems,
            and performs real work — no AI expertise required.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/auth/signin"
              className="w-full sm:w-auto px-8 py-3 bg-primary-600 text-white text-lg font-medium rounded-lg hover:bg-primary-700 transition-colors"
            >
              Request a Demo
            </Link>
            <Link
              href="/demo"
              className="w-full sm:w-auto px-8 py-3 border-2 border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 text-lg font-medium rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
            >
              See How It Works
            </Link>
          </div>
        </div>
      </section>

      <section id="features" className="py-20 px-4 bg-neutral-50 dark:bg-neutral-900/50">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-3xl font-bold text-center text-neutral-900 dark:text-neutral-50 mb-12">
            What Your AI Employee Does
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: 'cpu',
                title: 'Business-Specific Knowledge',
                description: 'Trained on your SOPs, policies, products, and terminology — not generic internet data.',
              },
              {
                icon: 'link',
                title: 'Connected to Your Systems',
                description: 'Securely integrates with email, CRM, calendar, documents, and your other tools.',
              },
              {
                icon: 'shield',
                title: 'Managed & Secure',
                description: 'We handle deployment, monitoring, improvements, and security — you just see results.',
              },
            ].map((feature) => (
              <div key={feature.title} className="p-6 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800">
                <div className="w-12 h-12 bg-primary-100 dark:bg-primary-900/30 rounded-lg flex items-center justify-center mb-4">
                  {feature.icon === 'cpu' && (
                    <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                    </svg>
                  )}
                  {feature.icon === 'link' && (
                    <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  )}
                  {feature.icon === 'shield' && (
                    <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                  )}
                </div>
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 mb-2">{feature.title}</h3>
                <p className="text-neutral-600 dark:text-neutral-400">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="border-t border-neutral-200 dark:border-neutral-800 py-12 px-4">
        <div className="max-w-7xl mx-auto text-center text-neutral-500 dark:text-neutral-400 text-sm">
          <p>AI Workforce Platform — Built for Australian SMEs</p>
        </div>
      </footer>
    </main>
  )
}
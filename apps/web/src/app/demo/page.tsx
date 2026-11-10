'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'

function useInView(threshold = 0.2) {
  const ref = useRef<HTMLDivElement>(null)
  const [isInView, setIsInView] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setIsInView(true) },
      { threshold }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [threshold])

  return { ref, isInView }
}

function AnimatedCounter({ end, duration = 2000, prefix = '', suffix = '' }: { end: number; duration?: number; prefix?: string; suffix?: string }) {
  const [count, setCount] = useState(0)
  const { ref, isInView } = useInView(0.5)

  useEffect(() => {
    if (!isInView) return
    let start = 0
    const increment = end / (duration / 16)
    const timer = setInterval(() => {
      start += increment
      if (start >= end) {
        setCount(end)
        clearInterval(timer)
      } else {
        setCount(Math.floor(start))
      }
    }, 16)
    return () => clearInterval(timer)
  }, [isInView, end, duration])

  return <span ref={ref}>{prefix}{count.toLocaleString()}{suffix}</span>
}

function StepCard({ number, title, description, icon, delay }: { number: number; title: string; description: string; icon: React.ReactNode; delay: number }) {
  const { ref, isInView } = useInView(0.3)

  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ${isInView ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      <div className="relative bg-white rounded-2xl p-8 shadow-lg hover:shadow-xl transition-shadow border border-neutral-100">
        <div className="absolute -top-4 -left-4 w-10 h-10 bg-primary-600 text-white rounded-full flex items-center justify-center font-bold text-lg shadow-lg">
          {number}
        </div>
        <div className="w-14 h-14 bg-primary-50 rounded-xl flex items-center justify-center mb-5 text-primary-600">
          {icon}
        </div>
        <h3 className="text-xl font-bold text-neutral-900 mb-3">{title}</h3>
        <p className="text-neutral-600 leading-relaxed">{description}</p>
      </div>
    </div>
  )
}

function PricingCard({ name, price, period, features, popular, delay }: { name: string; price: string; period: string; features: string[]; popular?: boolean; delay: number }) {
  const { ref, isInView } = useInView(0.3)

  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ${isInView ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      <div className={`relative rounded-2xl p-8 ${popular ? 'bg-primary-600 text-white ring-4 ring-primary-200 scale-105' : 'bg-white border border-neutral-200'} shadow-lg`}>
        {popular && (
          <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-yellow-400 text-yellow-900 text-xs font-bold px-4 py-1 rounded-full">
            MOST POPULAR
          </div>
        )}
        <h3 className={`text-lg font-bold mb-2 ${popular ? 'text-white' : 'text-neutral-900'}`}>{name}</h3>
        <div className="mb-6">
          <span className={`text-4xl font-extrabold ${popular ? 'text-white' : 'text-neutral-900'}`}>{price}</span>
          <span className={`text-sm ml-1 ${popular ? 'text-primary-100' : 'text-neutral-500'}`}>{period}</span>
        </div>
        <ul className="space-y-3 mb-8">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-3">
              <svg className={`w-5 h-5 mt-0.5 flex-shrink-0 ${popular ? 'text-primary-100' : 'text-primary-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className={`text-sm ${popular ? 'text-primary-50' : 'text-neutral-600'}`}>{f}</span>
            </li>
          ))}
        </ul>
        <Link
          href="/auth/signin"
          className={`block text-center py-3 rounded-xl font-semibold transition-colors ${
            popular
              ? 'bg-white text-primary-600 hover:bg-primary-50'
              : 'bg-primary-600 text-white hover:bg-primary-700'
          }`}
        >
          Get Started
        </Link>
      </div>
    </div>
  )
}

function FlowDiagram() {
  const { ref, isInView } = useInView(0.2)
  const steps = [
    { label: 'Your Business', icon: '🏢', color: 'bg-blue-100 border-blue-300 text-blue-700' },
    { label: 'Our Platform', icon: '⚙️', color: 'bg-primary-100 border-primary-300 text-primary-700' },
    { label: 'AI Employee', icon: '🤖', color: 'bg-purple-100 border-purple-300 text-purple-700' },
    { label: 'Your Tools', icon: '🔗', color: 'bg-green-100 border-green-300 text-green-700' },
    { label: 'Real Results', icon: '📈', color: 'bg-amber-100 border-amber-300 text-amber-700' },
  ]

  return (
    <div ref={ref} className="flex flex-col md:flex-row items-center justify-center gap-4 md:gap-0">
      {steps.map((step, i) => (
        <div key={step.label} className="flex items-center">
          <div
            className={`flex flex-col items-center transition-all duration-700 ${
              isInView ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'
            }`}
            style={{ transitionDelay: `${i * 200}ms` }}
          >
            <div className={`w-20 h-20 rounded-2xl border-2 ${step.color} flex items-center justify-center text-3xl shadow-md`}>
              {step.icon}
            </div>
            <span className="mt-2 text-sm font-semibold text-neutral-700 text-center">{step.label}</span>
          </div>
          {i < steps.length - 1 && (
            <div
              className={`hidden md:block transition-all duration-500 ${isInView ? 'opacity-100 scale-x-100' : 'opacity-0 scale-x-0'}`}
              style={{ transitionDelay: `${i * 200 + 100}ms` }}
            >
              <svg className="w-12 h-6 text-neutral-300" viewBox="0 0 48 24" fill="none">
                <path d="M0 12h40m0 0l-6-6m6 6l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          )}
          {i < steps.length - 1 && (
            <div
              className={`md:hidden transition-all duration-500 ${isInView ? 'opacity-100 scale-y-100' : 'opacity-0 scale-y-0'}`}
              style={{ transitionDelay: `${i * 200 + 100}ms` }}
            >
              <svg className="w-6 h-8 text-neutral-300" viewBox="0 0 24 32" fill="none">
                <path d="M12 0v24m0 0l-6-6m6 6l6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function RevenueChart() {
  const { ref, isInView } = useInView(0.3)
  const data = [
    { year: 'Year 1', value: 1200, label: '$1.2M', color: 'bg-primary-400' },
    { year: 'Year 2', value: 3600, label: '$3.6M', color: 'bg-primary-500' },
    { year: 'Year 3', value: 8400, label: '$8.4M', color: 'bg-primary-600' },
  ]

  return (
    <div ref={ref} className="flex items-end justify-center gap-8 h-64">
      {data.map((d, i) => (
        <div key={d.year} className="flex flex-col items-center gap-2">
          <span className={`text-lg font-bold text-primary-600 transition-all duration-700 ${isInView ? 'opacity-100' : 'opacity-0'}`} style={{ transitionDelay: `${i * 300}ms` }}>
            {d.label}
          </span>
          <div className="w-24 bg-neutral-100 rounded-t-xl overflow-hidden" style={{ height: '200px' }}>
            <div
              className={`w-full ${d.color} rounded-t-xl transition-all duration-1000 ease-out`}
              style={{
                height: isInView ? `${(d.value / 8400) * 100}%` : '0%',
                transitionDelay: `${i * 300}ms`,
              }}
            />
          </div>
          <span className="text-sm font-medium text-neutral-600">{d.year}</span>
        </div>
      ))}
    </div>
  )
}

function DashboardMockup() {
  const { ref, isInView } = useInView(0.2)
  const [activeTab, setActiveTab] = useState(0)
  const tabs = ['Overview', 'Agents', 'Workflows', 'Billing']

  const mockupContent = [
    {
      title: 'Business Dashboard',
      stats: [
        { label: 'Active AI Employees', value: '3', change: '+1 this month' },
        { label: 'Tasks Completed', value: '1,247', change: '+340 this week' },
        { label: 'Hours Saved', value: '892', change: 'Last 30 days' },
        { label: 'Customer Satisfaction', value: '98%', change: '+2% improvement' },
      ],
    },
    {
      title: 'Your AI Employees',
      stats: [
        { label: 'Sarah — Sales Assistant', value: 'Active', change: 'Qualifying leads since 9am' },
        { label: 'Mike — Support Agent', value: 'Active', change: 'Handled 23 tickets today' },
        { label: 'Lisa — Content Writer', value: 'Paused', change: 'Finished 5 blog posts' },
      ],
    },
    {
      title: 'Automated Workflows',
      stats: [
        { label: 'Lead Follow-up', value: 'Running', change: '24 leads in pipeline' },
        { label: 'Invoice Processing', value: 'Completed', change: '12 invoices processed' },
        { label: 'Social Media Posting', value: 'Scheduled', change: '6 posts queued' },
      ],
    },
    {
      title: 'Subscription & Billing',
      stats: [
        { label: 'Current Plan', value: 'Growth', change: '$799/month' },
        { label: 'Usage This Month', value: '68%', change: 'Within limits' },
        { label: 'Next Invoice', value: 'Oct 1', change: '$799.00' },
      ],
    },
  ]

  return (
    <div ref={ref} className={`transition-all duration-1000 ${isInView ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-12'}`}>
      <div className="bg-white rounded-2xl shadow-2xl border border-neutral-200 overflow-hidden max-w-4xl mx-auto">
        {/* Title bar */}
        <div className="bg-neutral-50 border-b border-neutral-200 px-6 py-3 flex items-center gap-3">
          <div className="flex gap-2">
            <div className="w-3 h-3 rounded-full bg-red-400" />
            <div className="w-3 h-3 rounded-full bg-yellow-400" />
            <div className="w-3 h-3 rounded-full bg-green-400" />
          </div>
          <div className="flex-1 text-center">
            <span className="text-sm text-neutral-500 font-medium">AI Workforce Dashboard</span>
          </div>
        </div>
        {/* Tabs */}
        <div className="flex border-b border-neutral-200 px-6">
          {tabs.map((tab, i) => (
            <button
              key={tab}
              onClick={() => setActiveTab(i)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === i
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-neutral-500 hover:text-neutral-700'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
        {/* Content */}
        <div className="p-6">
          <h3 className="text-lg font-bold text-neutral-900 mb-4">{mockupContent[activeTab].title}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {mockupContent[activeTab].stats.map((stat, i) => (
              <div
                key={stat.label}
                className={`bg-neutral-50 rounded-xl p-4 border border-neutral-100 transition-all duration-500 ${
                  isInView ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
                }`}
                style={{ transitionDelay: `${i * 100}ms` }}
              >
                <div className="text-sm text-neutral-500 mb-1">{stat.label}</div>
                <div className="text-2xl font-bold text-neutral-900">{stat.value}</div>
                <div className="text-xs text-neutral-400 mt-1">{stat.change}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ComparisonTable() {
  const { ref, isInView } = useInView(0.3)

  const rows = [
    { task: 'Answering the same questions', without: '3+ hours/day', with_: '24/7 automatically' },
    { task: 'Following up with leads', without: 'Missed 40% of leads', with_: 'Every lead, within 5 minutes' },
    { task: 'Processing invoices', without: 'Manual data entry', with_: 'Instant, error-free' },
    { task: 'Writing reports', without: 'Days of work', with_: 'Minutes to generate' },
  ]

  return (
    <div ref={ref} className="max-w-3xl mx-auto">
      <div className="bg-white rounded-2xl shadow-lg border border-neutral-200 overflow-hidden">
        <div className="grid grid-cols-3 bg-neutral-50 border-b border-neutral-200">
          <div className="p-4 text-sm font-bold text-neutral-700">Task</div>
          <div className="p-4 text-sm font-bold text-red-600 text-center">Without AI</div>
          <div className="p-4 text-sm font-bold text-green-600 text-center">With AI Workforce</div>
        </div>
        {rows.map((row, i) => (
          <div
            key={row.task}
            className={`grid grid-cols-3 border-b border-neutral-100 last:border-0 transition-all duration-500 ${
              isInView ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-4'
            }`}
            style={{ transitionDelay: `${i * 150}ms` }}
          >
            <div className="p-4 text-sm text-neutral-700 font-medium">{row.task}</div>
            <div className="p-4 text-sm text-red-500 text-center">{row.without}</div>
            <div className="p-4 text-sm text-green-600 text-center font-medium">{row.with_}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function DemoPage() {
  const [currentSection, setCurrentSection] = useState(0)
  const sectionRefs = useRef<(HTMLElement | null)[]>([])

  const sections = [
    'hero',
    'problem',
    'solution',
    'how-it-works',
    'before-after',
    'demo',
    'pricing',
    'revenue',
    'cta',
  ]

  const scrollToSection = useCallback((index: number) => {
    sectionRefs.current[index]?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const index = sectionRefs.current.indexOf(entry.target as HTMLElement)
            if (index !== -1) setCurrentSection(index)
          }
        })
      },
      { threshold: 0.3 }
    )

    sectionRefs.current.forEach((ref) => {
      if (ref) observer.observe(ref)
    })

    return () => observer.disconnect()
  }, [])

  return (
    <main className="bg-white text-neutral-900">
      {/* Floating nav dots */}
      <nav className="fixed right-6 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-3">
        {sections.map((s, i) => (
          <button
            key={s}
            onClick={() => scrollToSection(i)}
            className={`w-3 h-3 rounded-full transition-all duration-300 ${
              currentSection === i
                ? 'bg-primary-600 scale-125'
                : 'bg-neutral-300 hover:bg-neutral-400'
            }`}
            aria-label={`Go to ${s}`}
          />
        ))}
      </nav>

      {/* HERO */}
      <section
        ref={(el) => { sectionRefs.current[0] = el }}
        className="min-h-screen flex items-center justify-center px-6 relative overflow-hidden"
      >
        <div className="absolute inset-0 bg-gradient-to-br from-primary-50 via-white to-purple-50" />
        <div className="absolute top-20 left-10 w-72 h-72 bg-primary-200 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-float" />
        <div className="absolute bottom-20 right-10 w-72 h-72 bg-purple-200 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-float-delay" />
        <div className="relative z-10 text-center max-w-4xl mx-auto">
          <div className="animate-fade-in-up">
            <span className="inline-block px-4 py-2 bg-primary-100 text-primary-700 rounded-full text-sm font-semibold mb-6">
              Introducing AI Workforce
            </span>
            <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6 leading-tight">
              What if your business had
              <br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary-600 to-purple-600">
                an AI employee?
              </span>
            </h1>
            <p className="text-xl md:text-2xl text-neutral-600 mb-10 max-w-2xl mx-auto leading-relaxed">
              A smart assistant that knows your business, connects to your tools,
              and works around the clock — like hiring the perfect employee, but instantly.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <button
                onClick={() => scrollToSection(2)}
                className="px-8 py-4 bg-primary-600 text-white text-lg font-semibold rounded-xl hover:bg-primary-700 transition-all shadow-lg hover:shadow-xl hover:scale-105"
              >
                See How It Works →
              </button>
              <Link
                href="/auth/signin"
                className="px-8 py-4 border-2 border-neutral-300 text-neutral-700 text-lg font-semibold rounded-xl hover:bg-neutral-50 transition-all"
              >
                Try the Demo
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* THE PROBLEM */}
      <section
        ref={(el) => { sectionRefs.current[1] = el }}
        className="min-h-screen flex items-center justify-center px-6 py-20 bg-neutral-50"
      >
        <div className="w-full min-w-0 max-w-5xl mx-auto">
          <SectionTitle
            eyebrow="The Problem"
            title="Every day, businesses lose time and money on repetitive work"
            subtitle="Your team spends hours on tasks that don't need a human touch."
          />
          <div className="grid md:grid-cols-3 gap-8 mt-16">
            <AnimatedStat number={73} suffix="%" label="of employees spend time on tasks a computer could do" delay={0} />
            <AnimatedStat number={3} prefix="$" suffix=" trillion" label="lost annually to workplace inefficiency" delay={200} />
            <AnimatedStat number={40} suffix="%" label="of leads are never followed up on" delay={400} />
          </div>
        </div>
      </section>

      {/* THE SOLUTION */}
      <section
        ref={(el) => { sectionRefs.current[2] = el }}
        className="min-h-screen flex items-center justify-center px-6 py-20"
      >
        <div className="w-full min-w-0 max-w-5xl mx-auto">
          <SectionTitle
            eyebrow="The Solution"
            title="Meet your AI Employee"
            subtitle="It's like hiring someone who already knows your business, never sleeps, and costs a fraction of a salary."
          />
          <FlowDiagram />
          <div className="mt-16 text-center">
            <p className="text-lg text-neutral-500 max-w-2xl mx-auto">
              We build, train, and manage your AI employee. You just tell it what to do —
              like you would any new hire. No coding. No AI expertise needed.
            </p>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS - 5 Steps */}
      <section
        ref={(el) => { sectionRefs.current[3] = el }}
        className="min-h-screen flex items-center justify-center px-6 py-20 bg-neutral-50"
      >
        <div className="w-full min-w-0 max-w-6xl mx-auto">
          <SectionTitle
            eyebrow="How It Works"
            title="5 simple steps to your AI employee"
            subtitle="From sign-up to working AI employee in days, not months."
          />
          <div className="grid md:grid-cols-5 gap-6 mt-16">
            <StepCard
              number={1}
              title="Tell Us About You"
              description="Share your business name, industry, and what tasks you want help with."
              icon={
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              }
              delay={0}
            />
            <StepCard
              number={2}
              title="We Build Your AI"
              description="Our team creates a custom AI employee trained on your business knowledge."
              icon={
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              }
              delay={150}
            />
            <StepCard
              number={3}
              title="Connect Your Tools"
              description="Link your email, calendar, CRM, and other tools with a few clicks."
              icon={
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              }
              delay={300}
            />
            <StepCard
              number={4}
              title="We Test & Tune"
              description="We run tests to make sure your AI does exactly what you need, reliably."
              icon={
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              }
              delay={450}
            />
            <StepCard
              number={5}
              title="It's Working!"
              description="Your AI employee is live, doing real work, saving you time and money."
              icon={
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
              }
              delay={600}
            />
          </div>
        </div>
      </section>

      {/* BEFORE / AFTER */}
      <section
        ref={(el) => { sectionRefs.current[4] = el }}
        className="min-h-screen flex items-center justify-center px-6 py-20"
      >
        <div className="w-full min-w-0 max-w-5xl mx-auto">
          <SectionTitle
            eyebrow="Before & After"
            title="What changes when you hire an AI employee"
            subtitle="Real tasks. Real time savings. Real results."
          />
          <div className="mt-16">
            <ComparisonTable />
          </div>
        </div>
      </section>

      {/* DASHBOARD DEMO */}
      <section
        ref={(el) => { sectionRefs.current[5] = el }}
        className="min-h-screen flex items-center justify-center px-6 py-20 bg-neutral-50"
      >
        <div className="w-full min-w-0 max-w-6xl mx-auto">
          <SectionTitle
            eyebrow="Live Demo"
            title="Your command centre"
            subtitle="See everything at a glance. No spreadsheets. No guessing."
          />
          <div className="mt-16">
            <DashboardMockup />
          </div>
        </div>
      </section>

      {/* PRICING */}
      <section
        ref={(el) => { sectionRefs.current[6] = el }}
        className="min-h-screen flex items-center justify-center px-6 py-20"
      >
        <div className="w-full min-w-0 max-w-5xl mx-auto">
          <SectionTitle
            eyebrow="Simple Pricing"
            title="Pick the plan that fits your team"
            subtitle="No hidden fees. No lock-in contracts. Cancel anytime."
          />
          <div className="grid md:grid-cols-3 gap-8 mt-16 items-start">
            <PricingCard
              name="Starter"
              price="$299"
              period="/month"
              features={[
                '1 AI Employee',
                'Up to 10 workflows',
                '5 custom skills',
                '100 knowledge documents',
                'Email support',
              ]}
              delay={0}
            />
            <PricingCard
              name="Growth"
              price="$799"
              period="/month"
              features={[
                'Up to 5 AI Employees',
                'Up to 50 workflows',
                '20 custom skills',
                '1,000 knowledge documents',
                'Priority support',
                'Custom integrations',
              ]}
              popular
              delay={200}
            />
            <PricingCard
              name="Enterprise"
              price="$2,499"
              period="/month"
              features={[
                'Unlimited AI Employees',
                'Unlimited everything',
                'SSO & audit logs',
                'Dedicated support',
                'Custom SLA',
                'On-premise option',
              ]}
              delay={400}
            />
          </div>
        </div>
      </section>

      {/* REVENUE */}
      <section
        ref={(el) => { sectionRefs.current[7] = el }}
        className="min-h-screen flex items-center justify-center px-6 py-20 bg-neutral-50"
      >
        <div className="w-full min-w-0 max-w-5xl mx-auto">
          <SectionTitle
            eyebrow="Market Opportunity"
            title="Massive market, proven demand"
            subtitle="AI automation is the fastest-growing segment in enterprise software."
          />
          <div className="mt-16">
            <RevenueChart />
          </div>
          <div className="grid md:grid-cols-3 gap-8 mt-16">
            <AnimatedStat number={50} prefix="$" suffix="B+" label="AI automation market by 2028" delay={0} />
            <AnimatedStat number={19} suffix=":1" label="LTV to Customer Acquisition Cost ratio" delay={200} />
            <AnimatedStat number={82} suffix="%" label="Gross margin at scale" delay={400} />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section
        ref={(el) => { sectionRefs.current[8] = el }}
        className="min-h-[70vh] flex items-center justify-center px-6 py-20"
      >
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-4xl md:text-5xl font-extrabold mb-6">
            Ready to see it in action?
          </h2>
          <p className="text-xl text-neutral-600 mb-10 leading-relaxed">
            Join the businesses already saving hundreds of hours with AI employees.
            It takes 5 minutes to explore the demo.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/auth/signin"
              className="px-10 py-4 bg-primary-600 text-white text-lg font-semibold rounded-xl hover:bg-primary-700 transition-all shadow-lg hover:shadow-xl hover:scale-105"
            >
              Explore the Live Demo →
            </Link>
            <Link
              href="/auth/signin"
              className="px-10 py-4 border-2 border-neutral-300 text-neutral-700 text-lg font-semibold rounded-xl hover:bg-neutral-50 transition-all"
            >
              Schedule a Call
            </Link>
          </div>
          <div className="mt-12 flex items-center justify-center gap-8 text-sm text-neutral-500">
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              No credit card required
            </span>
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              Free 14-day trial
            </span>
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              Cancel anytime
            </span>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-neutral-200 py-8 px-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-sm text-neutral-500">
          <span>AI Workforce Platform</span>
          <span>Built for Australian SMEs</span>
        </div>
      </footer>
    </main>
  )
}

/* ─── Shared sub-components ─── */

function SectionTitle({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  const { ref, isInView } = useInView(0.3)

  return (
    <div ref={ref} className={`text-center transition-all duration-700 ${isInView ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'}`}>
      <span className="inline-block px-4 py-1.5 bg-primary-100 text-primary-700 rounded-full text-sm font-semibold mb-4">
        {eyebrow}
      </span>
      <h2 className="text-3xl md:text-5xl font-extrabold tracking-tight mb-4">{title}</h2>
      <p className="text-lg text-neutral-500 max-w-2xl mx-auto">{subtitle}</p>
    </div>
  )
}

function AnimatedStat({ number, prefix = '', suffix = '', label, delay = 0 }: { number: number; prefix?: string; suffix?: string; label: string; delay?: number }) {
  const { ref, isInView } = useInView(0.5)
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!isInView) return
    const timer = setTimeout(() => {
      let start = 0
      const duration = 2000
      const increment = number / (duration / 16)
      const counter = setInterval(() => {
        start += increment
        if (start >= number) {
          setCount(number)
          clearInterval(counter)
        } else {
          setCount(Math.floor(start))
        }
      }, 16)
      return () => clearInterval(counter)
    }, delay)
    return () => clearTimeout(timer)
  }, [isInView, number, delay])

  return (
    <div
      ref={ref}
      className={`text-center transition-all duration-700 ${isInView ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      <div className="text-4xl md:text-5xl font-extrabold text-primary-600 mb-2">
        {prefix}{count.toLocaleString()}{suffix}
      </div>
      <p className="text-neutral-600 text-sm leading-relaxed">{label}</p>
    </div>
  )
}

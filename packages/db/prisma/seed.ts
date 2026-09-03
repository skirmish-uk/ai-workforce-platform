import { prisma } from '../src'
import { hash } from 'bcryptjs'

async function main() {
  console.log('🌱 Seeding database...')

  // Create platform admin tenant
  const platformTenant = await prisma.tenant.upsert({
    where: { slug: 'platform' },
    update: {},
    create: {
      name: 'Platform Operations',
      slug: 'platform',
      industry: 'Technology',
      geography: 'Australia',
    },
  })

  // Create platform admin user
  const adminPassword = await hash('admin123', 12)
  await prisma.user.upsert({
    where: { email: 'admin@platform.local' },
    update: {},
    create: {
      email: 'admin@platform.local',
      name: 'Platform Admin',
      passwordHash: adminPassword,
      role: 'PLATFORM_ADMIN',
      tenantId: platformTenant.id,
    },
  })

  // Create demo tenant
  const demoTenant = await prisma.tenant.upsert({
    where: { slug: 'demo-agency' },
    update: {},
    create: {
      name: 'Demo Marketing Agency',
      slug: 'demo-agency',
      industry: 'Marketing',
      geography: 'Australia',
    },
  })

  // Create demo customer admin
  const demoPassword = await hash('demo123', 12)
  const demoUser = await prisma.user.upsert({
    where: { email: 'admin@demo-agency.local' },
    update: {},
    create: {
      email: 'admin@demo-agency.local',
      name: 'Demo Admin',
      passwordHash: demoPassword,
      role: 'CUSTOMER_ADMIN',
      tenantId: demoTenant.id,
    },
  })

  // Create demo staff user
  await prisma.user.upsert({
    where: { email: 'staff@demo-agency.local' },
    update: {},
    create: {
      email: 'staff@demo-agency.local',
      name: 'Demo Staff',
      passwordHash: demoPassword,
      role: 'CUSTOMER_STAFF',
      tenantId: demoTenant.id,
    },
  })

  // Create sample skills
  const leadFollowUpSkill = await prisma.skill.upsert({
    where: { name_version_tenantId: { name: 'lead_follow_up', version: '1.0.0', tenantId: demoTenant.id } },
    update: {},
    create: {
      name: 'lead_follow_up',
      version: '1.0.0',
      description: 'Follow up with qualified leads according to approved process',
      purpose: 'Convert qualified leads into booked meetings',
      instructions: `1. Review lead details and history
2. Check if lead has been contacted recently
3. Send personalized follow-up email
4. Log activity in CRM
5. Schedule next follow-up if no response`,
      requiredTools: ['crm', 'email'],
      inputs: { lead: 'object', history: 'array', companyContext: 'object' },
      outputs: { actionTaken: 'string', crmUpdate: 'object', nextFollowUpDate: 'string' },
      constraints: ['Never invent pricing', 'Never make commitments outside approved policy', 'Escalate uncertain requests'],
      failureHandling: { missingData: 'escalate', toolFailure: 'retry_once_then_escalate', ambiguousCase: 'escalate' },
      evaluationCases: [
        { input: { lead: { name: 'John Doe', status: 'qualified' } }, expected: 'send_follow_up_email' },
        { input: { lead: { name: 'Jane Smith', status: 'contacted_recently' } }, expected: 'skip_and_schedule' },
      ],
      metadata: { category: 'sales', tags: ['lead', 'follow-up', 'email'] },
      tenantId: demoTenant.id,
    },
  })

  const emailTriageSkill = await prisma.skill.upsert({
    where: { name_version_tenantId: { name: 'email_triage', version: '1.0.0', tenantId: demoTenant.id } },
    update: {},
    create: {
      name: 'email_triage',
      version: '1.0.0',
      description: 'Classify and prioritize incoming emails',
      purpose: 'Reduce inbox overload by routing emails to appropriate handlers',
      instructions: `1. Fetch unread emails
2. Classify each email (spam, urgent, routine, newsletter, etc.)
3. Apply labels/tags
4. Forward urgent emails to Slack/Teams
5. Archive spam/newsletters`,
      requiredTools: ['email', 'messaging'],
      inputs: { emails: 'array', rules: 'object' },
      outputs: { classified: 'array', forwarded: 'array', archived: 'array' },
      constraints: ['Never delete emails', 'Preserve original content', 'Respect privacy'],
      failureHandling: { classificationError: 'mark_for_review', forwardFailure: 'retry' },
      evaluationCases: [
        { input: { subject: 'Urgent: Contract Review', from: 'legal@client.com' }, expected: 'classify_urgent' },
        { input: { subject: 'Weekly Newsletter', from: 'marketing@vendor.com' }, expected: 'classify_newsletter' },
      ],
      metadata: { category: 'productivity', tags: ['email', 'triage', 'classification'] },
      tenantId: demoTenant.id,
    },
  })

  // Create sample agent
  const agent = await prisma.agent.upsert({
    where: { id: 'demo-agent-1' },
    update: {},
    create: {
      id: 'demo-agent-1',
      name: 'Sarah - Sales Assistant',
      role: 'Sales Development Representative',
      mission: 'Help the sales team qualify leads, follow up with prospects, and book meetings',
      systemPrompt: `You are Sarah, a Sales Development Representative for Demo Marketing Agency.

Your responsibilities:
- Qualify incoming leads based on our ICP
- Follow up with leads via email and phone
- Book meetings for Account Executives
- Maintain accurate CRM records
- Escalate complex opportunities

Guidelines:
- Always be professional and helpful
- Never invent pricing or make commitments
- Use the company knowledge base for accurate information
- Log all activities in CRM
- Escalate when unsure`,
      modelProvider: 'anthropic',
      modelName: 'claude-3-sonnet-20240229',
      modelConfig: { temperature: 0.3, maxTokens: 4096 },
      status: 'DRAFT',
      tenantId: demoTenant.id,
    },
  })

  // Link skills to agent
  await prisma.agentSkill.upsert({
    where: { agentId_skillId: { agentId: agent.id, skillId: leadFollowUpSkill.id } },
    update: {},
    create: { agentId: agent.id, skillId: leadFollowUpSkill.id, enabled: true },
  })

  await prisma.agentSkill.upsert({
    where: { agentId_skillId: { agentId: agent.id, skillId: emailTriageSkill.id } },
    update: {},
    create: { agentId: agent.id, skillId: emailTriageSkill.id, enabled: true },
  })

  // Create sample permissions
  await prisma.agentPermission.createMany({
    data: [
      { agentId: agent.id, action: 'email_send', level: 'CUSTOMER_APPROVAL', conditions: { maxPerDay: 50 } },
      { agentId: agent.id, action: 'crm_write', level: 'AUTOMATIC', conditions: { objects: ['Lead', 'Activity'] } },
      { agentId: agent.id, action: 'calendar_create', level: 'AUTOMATIC', conditions: { type: 'meeting' } },
      { agentId: agent.id, action: 'file_delete', level: 'PROHIBITED', conditions: {} },
    ],
    skipDuplicates: true,
  })

  // Create sample knowledge documents
  await prisma.knowledgeDocument.createMany({
    data: [
      {
        title: 'Company Overview',
        content: 'Demo Marketing Agency is a full-service digital marketing agency based in Sydney, Australia. We specialize in SEO, PPC, content marketing, and social media management for B2B technology companies.',
        contentType: 'text/markdown',
        metadata: { category: 'company', tags: ['overview', 'services'] },
        tenantId: demoTenant.id,
      },
      {
        title: 'Ideal Customer Profile',
        content: 'Our ideal customers are B2B technology companies with 50-500 employees, $5M+ ARR, looking to scale their digital marketing. Decision makers are typically CMOs or VP Marketing.',
        contentType: 'text/markdown',
        metadata: { category: 'sales', tags: ['icp', 'qualification'] },
        tenantId: demoTenant.id,
      },
      {
        title: 'Pricing Guidelines',
        content: 'Standard packages: Starter $3,000/mo, Growth $7,500/mo, Enterprise $15,000/mo. Custom quotes require approval. Never discount more than 15% without director approval.',
        contentType: 'text/markdown',
        metadata: { category: 'sales', tags: ['pricing', 'guidelines'] },
        tenantId: demoTenant.id,
      },
    ],
    skipDuplicates: true,
  })

  // Create sample integration configs
  await prisma.integration.createMany({
    data: [
      {
        name: 'Gmail',
        provider: 'google',
        config: { scopes: ['gmail.readonly', 'gmail.send', 'gmail.modify'] },
        credentials: { encrypted: true },
        scopes: ['gmail.readonly', 'gmail.send', 'gmail.modify'],
        tenantId: demoTenant.id,
      },
      {
        name: 'HubSpot CRM',
        provider: 'hubspot',
        config: { baseUrl: 'https://api.hubapi.com' },
        credentials: { encrypted: true },
        scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.deals.read', 'crm.objects.deals.write'],
        tenantId: demoTenant.id,
      },
    ],
    skipDuplicates: true,
  })

  // Create sample subscription
  await prisma.subscription.create({
    data: {
      plan: 'growth',
      status: 'ACTIVE',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      interval: 'MONTHLY',
      planTier: 'GROWTH',
      tenantId: demoTenant.id,
    },
  })

  console.log('✅ Database seeded successfully!')
  console.log('')
  console.log('Demo credentials:')
  console.log('  Platform Admin: admin@platform.local / admin123')
  console.log('  Demo Admin: admin@demo-agency.local / demo123')
  console.log('  Demo Staff: staff@demo-agency.local / demo123')
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
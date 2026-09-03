import { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { PrismaAdapter } from '@auth/prisma-adapter'
import { prisma } from '@ai-workforce/db'
import { compare } from 'bcryptjs'
import { z } from 'zod'

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantSlug: z.string().optional(),
})

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma) as NextAuthOptions['adapter'],
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email', placeholder: 'admin@demo-agency.local' },
        password: { label: 'Password', type: 'password' },
        tenantSlug: { label: 'Tenant', type: 'text', placeholder: 'demo-agency' },
      },
      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials)
        if (!parsed.success) {
          throw new Error('Invalid credentials')
        }

        const { email, password, tenantSlug } = parsed.data

        const user = await prisma.user.findUnique({
          where: { email },
          include: { tenant: true },
        })

        if (!user || !user.passwordHash) {
          throw new Error('Invalid credentials')
        }

        // Verify tenant if provided
        if (tenantSlug && user.tenant.slug !== tenantSlug) {
          throw new Error('Invalid tenant')
        }

        const isValid = await compare(password, user.passwordHash)
        if (!isValid) {
          throw new Error('Invalid credentials')
        }

        if (!user.tenant) {
          throw new Error('No tenant associated')
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          image: user.image,
          tenantId: user.tenantId,
          tenantSlug: user.tenant.slug,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id
        token.role = (user as any).role
        token.tenantId = (user as any).tenantId
        token.tenantSlug = (user as any).tenantSlug
      }

      if (trigger === 'update' && session) {
        token.name = session.name
        token.image = session.image
      }

      return token
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string
        session.user.role = token.role as string
        session.user.tenantId = token.tenantId as string
        session.user.tenantSlug = token.tenantSlug as string
      }
      return session
    },
  },
  events: {
    async signIn({ user, isNewUser }) {
      await prisma.auditLog.create({
        data: {
          action: 'USER_SIGN_IN',
          entityType: 'User',
          entityId: user.id,
          tenantId: (user as any).tenantId,
          userId: user.id,
          metadata: { isNewUser },
        },
      })
    },
  },
  debug: process.env.NODE_ENV === 'development',
  secret: process.env.NEXTAUTH_SECRET,
}

declare module 'next-auth' {
  interface User {
    role: string
    tenantId: string
    tenantSlug: string
  }

  interface Session {
    user: {
      id: string
      email: string
      name?: string | null
      image?: string | null
      role: string
      tenantId: string
      tenantSlug: string
    }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id: string
    role: string
    tenantId: string
    tenantSlug: string
  }
}
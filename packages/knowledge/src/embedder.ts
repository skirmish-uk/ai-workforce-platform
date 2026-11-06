import OpenAI from 'openai'

const EMBEDDING_MODEL = 'text-embedding-3-small'
export const EMBEDDING_DIMENSIONS = 1536

let client: OpenAI | null = null

function getClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not configured. Knowledge embeddings use OpenAI text-embedding-3-small even when the agent itself runs on Anthropic.'
    )
  }
  if (!client) client = new OpenAI({ apiKey })
  return client
}

export function isEmbeddingConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY)
}

export async function embedText(text: string): Promise<number[]> {
  const response = await getClient().embeddings.create({ model: EMBEDDING_MODEL, input: text })
  return response.data[0].embedding
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return []
  const response = await getClient().embeddings.create({ model: EMBEDDING_MODEL, input: texts })
  return response.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

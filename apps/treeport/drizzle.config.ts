import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/core/database-schema.ts',
  out: './drizzle'
})

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/core/database-schema.ts',
  out: './drizzle'
})

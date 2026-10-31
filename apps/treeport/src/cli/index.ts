#!/usr/bin/env node
import { runCliApplication } from './application.ts'

process.exitCode = await runCliApplication({ args: process.argv.slice(2) })

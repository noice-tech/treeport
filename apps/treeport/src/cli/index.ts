#!/usr/bin/env node
import { runCliApplication } from './application.js'

process.exitCode = await runCliApplication({ args: process.argv.slice(2) })

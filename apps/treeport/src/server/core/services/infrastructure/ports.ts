import * as Context from 'effect/Context'
import type { AppConfig } from '../../config.ts'
import type { EffectCommandRunner } from '../../command.ts'
import type { ProductEventBus } from '../../events.ts'
import type { PackageSystem } from '../../package-system.ts'
import type { TerminalSessionBackend } from '../../terminal.ts'

export class ConfigPort extends Context.Tag('treeport/Config')<
  ConfigPort,
  AppConfig
>() {}

export class CommandPort extends Context.Tag('treeport/Command')<
  CommandPort,
  EffectCommandRunner
>() {}

export class TerminalHostPort extends Context.Tag('treeport/TerminalHost')<
  TerminalHostPort,
  TerminalSessionBackend
>() {}

export class EventBusPort extends Context.Tag('treeport/EventBus')<
  EventBusPort,
  ProductEventBus
>() {}

export class PackageSystemPort extends Context.Tag('treeport/PackageSystem')<
  PackageSystemPort,
  PackageSystem
>() {}

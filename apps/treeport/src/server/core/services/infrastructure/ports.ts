import * as Context from 'effect/Context'
import type { AppConfig } from '../../config'
import type { CommandRunner } from '../../command'
import type { TreeportDatabase } from '../../database'
import type { ProductEventBus } from '../../events'
import type { GhAdapter } from '../../gh'
import type { GitAdapter } from '../../git'
import type { NetworkListenerAdapter } from '../../network-listeners'
import type { PackageSystem } from '../../package-system'
import type { TerminalSessionBackend } from '../../terminal'
import type { WebPanelViteRuntime } from '../../web-panel-vite-runtime'

export class ConfigPort extends Context.Tag('treeport/Config')<
  ConfigPort,
  AppConfig
>() {}

export class DatabasePort extends Context.Tag('treeport/Database')<
  DatabasePort,
  TreeportDatabase
>() {}

export class CommandPort extends Context.Tag('treeport/Command')<
  CommandPort,
  CommandRunner
>() {}

export class GitPort extends Context.Tag('treeport/Git')<
  GitPort,
  GitAdapter
>() {}

export class GitHubPort extends Context.Tag('treeport/GitHub')<
  GitHubPort,
  GhAdapter
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

export class NetworkListenerPort extends Context.Tag(
  'treeport/NetworkListener'
)<NetworkListenerPort, NetworkListenerAdapter>() {}

export class WebPanelRuntimePort extends Context.Tag(
  'treeport/WebPanelRuntime'
)<WebPanelRuntimePort, WebPanelViteRuntime>() {}

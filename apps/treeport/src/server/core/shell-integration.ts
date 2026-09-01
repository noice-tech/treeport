import fs from 'node:fs/promises'
import path from 'node:path'

const ZSH_DELEGATE = (
  file: string
) => `if [[ -r "$TREEPORT_USER_ZDOTDIR/${file}" ]]; then
  _treeport_integration_zdotdir=$ZDOTDIR
  ZDOTDIR=$TREEPORT_USER_ZDOTDIR
  source "$ZDOTDIR/${file}"
  TREEPORT_USER_ZDOTDIR=$ZDOTDIR
  ZDOTDIR=$_treeport_integration_zdotdir
  unset _treeport_integration_zdotdir
fi
`

const ZSH_INTEGRATION = `${ZSH_DELEGATE('.zshrc')}
if [[ -n "$TREEPORT_SHELL_INTEGRATION" ]]; then
  unset TREEPORT_SHELL_INTEGRATION
  autoload -Uz add-zsh-hook 2>/dev/null
  _treeport_command_title_preexec() {
    emulate -L zsh
    local title=\${1//[[:cntrl:]]/}
    title=\${title[1,256]}
    printf '\\033]777;command;%s\\033\\\\' "$title"
  }
  _treeport_command_title_precmd() {
    emulate -L zsh
    printf '\\033]777;command;\\033\\\\'
  }
  add-zsh-hook -d preexec _treeport_command_title_preexec 2>/dev/null
  add-zsh-hook -d precmd _treeport_command_title_precmd 2>/dev/null
  add-zsh-hook preexec _treeport_command_title_preexec
  add-zsh-hook precmd _treeport_command_title_precmd
fi

ZDOTDIR=$TREEPORT_USER_ZDOTDIR
unset TREEPORT_USER_ZDOTDIR
`

const BASH_INTEGRATION = `[[ $- == *i* ]] || return

unset TREEPORT_SHELL_INTEGRATION

_treeport_command_title_preexec() {
  local fallback=\${1-} line title
  line=$(HISTTIMEFORMAT= builtin history 1)
  line="\${line#"\${line%%[![:space:]]*}"}"
  line="\${line#* }"
  title="\${line#"\${line%%[![:space:]]*}"}"
  [[ -n "$title" ]] || title=$fallback
  title=$(LC_ALL=C printf '%s' "$title" | tr -d '\\000-\\037\\177')
  title="\${title:0:256}"
  printf '\\033]777;command;%s\\033\\\\' "$title"
}
_treeport_command_title_prompt() {
  printf '\\033]777;command;\\033\\\\'
  [[ -n "\${_treeport_uses_debug_trap-}" ]] && _treeport_command_ready=1
}

# PS0 provides a non-invasive preexec boundary in Bash 4.4 and newer. On
# older Bash, use DEBUG only when doing so will not replace a user trap.
_treeport_title_integration_ready=
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  PS0='$(_treeport_command_title_preexec)'"\${PS0-}"
  _treeport_title_integration_ready=1
elif [[ -z "$(trap -p DEBUG)" ]]; then
  _treeport_uses_debug_trap=1
  _treeport_command_ready=0
  trap 'if [[ $_treeport_command_ready == 1 ]]; then _treeport_command_ready=0; _treeport_command_title_preexec "$BASH_COMMAND"; fi' DEBUG
  _treeport_title_integration_ready=1
fi
if [[ -n "$_treeport_title_integration_ready" ]]; then
  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
    PROMPT_COMMAND=("\${PROMPT_COMMAND[@]}" _treeport_command_title_prompt)
  else
    PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND;}_treeport_command_title_prompt"
  fi
fi
unset _treeport_title_integration_ready
if [[ -n "\${_treeport_uses_debug_trap-}" ]]; then
  _treeport_command_ready=1
fi
`

const BASH_PROFILE_DELEGATE = `_treeport_integration_home=$HOME
HOME=$TREEPORT_USER_HOME
unset TREEPORT_USER_HOME
if [[ -r "$HOME/.bash_profile" ]]; then
  source "$HOME/.bash_profile"
elif [[ -r "$HOME/.bash_login" ]]; then
  source "$HOME/.bash_login"
elif [[ -r "$HOME/.profile" ]]; then
  source "$HOME/.profile"
fi
source "$_treeport_integration_home/../treeport.bash"
unset _treeport_integration_home
`

const BASH_RC_DELEGATE = `_treeport_integration_home=$HOME
HOME=$TREEPORT_USER_HOME
unset TREEPORT_USER_HOME
[[ -r "$HOME/.bashrc" ]] && source "$HOME/.bashrc"
source "$_treeport_integration_home/../treeport.bash"
unset _treeport_integration_home
`

const FISH_INTEGRATION = `if set -q TREEPORT_FISH_XDG_DATA_DIR
  if set -q TREEPORT_FISH_XDG_DATA_DIRS_SET
    set -l treeport_xdg_dirs
    for treeport_xdg_dir in (string split : -- "$XDG_DATA_DIRS")
      if test "$treeport_xdg_dir" != "$TREEPORT_FISH_XDG_DATA_DIR"
        set -a treeport_xdg_dirs "$treeport_xdg_dir"
      end
    end
    set -gx XDG_DATA_DIRS (string join : -- $treeport_xdg_dirs)
  else
    set -e XDG_DATA_DIRS
  end
  set -e TREEPORT_FISH_XDG_DATA_DIR TREEPORT_FISH_XDG_DATA_DIRS_SET
end
set -e TREEPORT_SHELL_INTEGRATION

function _treeport_command_title_preexec --on-event fish_preexec
  set -l title (string replace -ar '[[:cntrl:]]' '' -- "$argv[1]" | string sub -l 256)
  printf '\\e]777;command;%s\\e\\\\' "$title"
end

function _treeport_command_title_prompt --on-event fish_prompt
  printf '\\e]777;command;\\e\\\\'
end
`

export async function prepareShellIntegration(root: string): Promise<void> {
  const zshDir = path.join(root, 'zsh')
  const bashDir = path.join(root, 'bash')
  const bashHome = path.join(bashDir, 'home')
  const fishDir = path.join(root, 'fish', 'fish', 'vendor_conf.d')
  await Promise.all([
    fs.mkdir(zshDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(bashHome, { recursive: true, mode: 0o700 }),
    fs.mkdir(fishDir, { recursive: true, mode: 0o700 })
  ])
  await Promise.all([
    ...['.zshenv', '.zprofile', '.zlogin', '.zlogout'].map((file) =>
      fs.writeFile(path.join(zshDir, file), ZSH_DELEGATE(file), {
        mode: 0o600
      })
    ),
    fs.writeFile(path.join(zshDir, '.zshrc'), ZSH_INTEGRATION, {
      mode: 0o600
    }),
    fs.writeFile(path.join(bashDir, 'treeport.bash'), BASH_INTEGRATION, {
      mode: 0o600
    }),
    fs.writeFile(path.join(bashHome, '.bash_profile'), BASH_PROFILE_DELEGATE, {
      mode: 0o600
    }),
    fs.writeFile(path.join(bashHome, '.bashrc'), BASH_RC_DELEGATE, {
      mode: 0o600
    }),
    fs.writeFile(path.join(fishDir, 'treeport.fish'), FISH_INTEGRATION, {
      mode: 0o600
    })
  ])
}

interface ShellLaunch {
  argv: string[]
  env: NodeJS.ProcessEnv
}

export function integrateShellLaunch(
  argv: string[],
  env: NodeJS.ProcessEnv,
  root: string | undefined,
  enabled: boolean
): ShellLaunch {
  const shell = path.basename(argv[0] ?? '').replace(/^-/, '')
  if (!root || !enabled || !['zsh', 'bash', 'fish'].includes(shell)) {
    return { argv, env }
  }

  let positional = false
  if (shell !== 'bash') {
    let hasCommandOption = false
    for (const argument of argv.slice(1)) {
      if (positional) {
        hasCommandOption = argument !== '-'
        break
      }

      if (argument === '--') {
        positional = true
      } else if (
        argument === '--command' ||
        argument.startsWith('--command=') ||
        (argument.startsWith('-') &&
          !argument.startsWith('--') &&
          argument.slice(1).includes('c'))
      ) {
        hasCommandOption = true
        break
      } else if (!argument.startsWith('-') && argument !== '-') {
        hasCommandOption = true
        break
      }
    }
    if (hasCommandOption) {
      return { argv, env }
    }
  }

  const integratedEnv = {
    ...env,
    TREEPORT_SHELL_INTEGRATION: '1'
  }
  if (shell === 'zsh') {
    const integrationZdotDir = path.join(root, 'zsh')
    const configuredZdotDir = env.ZDOTDIR?.trim()
    const userZdotDir =
      configuredZdotDir &&
      path.resolve(configuredZdotDir) !== path.resolve(integrationZdotDir)
        ? configuredZdotDir
        : env.HOME?.trim()
    if (!userZdotDir) {
      return { argv, env }
    }

    return {
      argv,
      env: {
        ...integratedEnv,
        TREEPORT_USER_ZDOTDIR: userZdotDir,
        ZDOTDIR: integrationZdotDir
      }
    }
  }

  if (shell === 'fish') {
    const integrationDataDir = path.join(root, 'fish')
    const fishEnvironment: NodeJS.ProcessEnv = {
      ...integratedEnv,
      TREEPORT_FISH_XDG_DATA_DIR: integrationDataDir,
      XDG_DATA_DIRS: [integrationDataDir, env.XDG_DATA_DIRS]
        .filter(Boolean)
        .join(':')
    }
    if (env.XDG_DATA_DIRS !== undefined) {
      fishEnvironment.TREEPORT_FISH_XDG_DATA_DIRS_SET = '1'
    }

    return { argv, env: fishEnvironment }
  }

  positional = false
  for (const argument of argv.slice(1)) {
    if (positional) {
      if (argument !== '-') {
        return { argv, env }
      }

      continue
    }

    if (argument === '--') {
      positional = true
    } else if (
      argument === '--posix' ||
      argument === '--command' ||
      argument.startsWith('--command=') ||
      (argument.startsWith('-') &&
        !argument.startsWith('--') &&
        argument.slice(1).includes('c'))
    ) {
      return { argv, env }
    } else if (!argument.startsWith('-') && argument !== '-') {
      return { argv, env }
    }
  }

  const userHome = env.HOME?.trim()
  if (!userHome) {
    return { argv, env }
  }

  return {
    argv,
    env: {
      ...integratedEnv,
      HOME: path.join(root, 'bash', 'home'),
      TREEPORT_USER_HOME: userHome
    }
  }
}

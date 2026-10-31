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

const CLI_PATH = `# User startup files may prepend another treeport; keep this server's CLI first.
[[ -n "\${TREEPORT_CLI_ENTRYPOINT-}" && $PATH != "\${TREEPORT_CLI_ENTRYPOINT%/*}:"* ]] && PATH="\${TREEPORT_CLI_ENTRYPOINT%/*}:$PATH"
`

const ZSH_INTEGRATION = `${ZSH_DELEGATE('.zshrc')}${CLI_PATH}
if [[ -n "$TREEPORT_SHELL_INTEGRATION" ]]; then
  unset TREEPORT_SHELL_INTEGRATION
  autoload -Uz add-zsh-hook 2>/dev/null
  _treeport_command_start() {
    emulate -L zsh
    local line=\${1//[[:cntrl:]]/}
    line=\${line//\\%/%25}
    printf '\\033]133;C;cmdline_url=%s\\033\\\\' "\${line//;/%3B}"
  }
  _treeport_command_end() {
    local command_status=$?
    # A directory or host name with a raw ESC or BEL could end OSC 7 early and inject its own sequence.
    printf '\\033]133;D;%s\\033\\\\\\033]7;kitty-shell-cwd://%s%s\\033\\\\\\033]133;A\\033\\\\' "$command_status" "\${HOST//[[:cntrl:]]/}" "\${PWD//[[:cntrl:]]/}"
  }
  _treeport_prompt_end() {
    printf '\\033]133;B\\033\\\\'
  }
  add-zsh-hook -d preexec _treeport_command_start 2>/dev/null
  add-zsh-hook preexec _treeport_command_start
  autoload -Uz add-zle-hook-widget 2>/dev/null && add-zle-hook-widget line-init _treeport_prompt_end
  precmd_functions=(_treeport_command_end \${precmd_functions:#_treeport_command_end})
  if [[ -n "\${TREEPORT_RUN_COMMAND+x}" ]]; then
    _treeport_run_command=$TREEPORT_RUN_COMMAND
    _treeport_run_after=\${TREEPORT_RUN_AFTER:-shell}
    _treeport_run_result=\${TREEPORT_RUN_RESULT-}
    unset TREEPORT_RUN_COMMAND TREEPORT_RUN_AFTER TREEPORT_RUN_RESULT
    _treeport_run_precmd() {
      add-zsh-hook -d precmd _treeport_run_precmd
      print -rs -- "$_treeport_run_command"
      local hook run_status
      for hook in preexec $preexec_functions; do
        (( $+functions[$hook] )) && $hook "$_treeport_run_command" "$_treeport_run_command" "$_treeport_run_command"
      done
      eval "$_treeport_run_command"
      run_status=$?
      if [[ -n $_treeport_run_result ]]; then
        print -r -- $run_status >| "$_treeport_run_result.tmp" && command mv -f -- "$_treeport_run_result.tmp" "$_treeport_run_result"
      fi
      if [[ $_treeport_run_after == close || ( $_treeport_run_after == closeOnSuccess && $run_status == 0 ) ]]; then
        exit $run_status
      fi
      unset _treeport_run_command _treeport_run_after _treeport_run_result
      for hook in precmd $precmd_functions; do
        if (( $+functions[$hook] )); then
          () { return $1 } $run_status
          $hook
        fi
      done
    }
    add-zsh-hook precmd _treeport_run_precmd
  fi
fi

ZDOTDIR=$TREEPORT_USER_ZDOTDIR
unset TREEPORT_USER_ZDOTDIR
`

const BASH_INTEGRATION = `[[ $- == *i* ]] || return

${CLI_PATH}
unset TREEPORT_SHELL_INTEGRATION

_treeport_command_start() {
  local fallback=\${1-} line
  line=$(HISTTIMEFORMAT= builtin history 1)
  line="\${line#"\${line%%[![:space:]]*}"}"
  line="\${line#* }"
  line="\${line#"\${line%%[![:space:]]*}"}"
  [[ -n "$line" ]] || line=$fallback
  line=$(LC_ALL=C printf '%s' "$line" | tr -d '\\000-\\037\\177')
  line=\${line//\\%/%25}
  printf '\\033]133;C;cmdline_url=%s\\033\\\\' "\${line//;/%3B}"
}
_treeport_command_end() {
  local command_status=$?
  # A directory or host name with a raw ESC or BEL could end OSC 7 early and inject its own sequence.
  printf '\\033]133;D;%s\\033\\\\\\033]7;kitty-shell-cwd://%s%s\\033\\\\\\033]133;A\\033\\\\' "$command_status" "\${HOSTNAME//[[:cntrl:]]/}" "\${PWD//[[:cntrl:]]/}"
  return "$command_status"
}
_treeport_command_ready_prompt() {
  [[ $PS1 == *'133;B'* ]] || PS1+='\\[\\e]133;B\\e\\\\\\]'
  [[ -n "\${_treeport_uses_debug_trap-}" ]] && _treeport_command_ready=1
}

# PS0 provides a non-invasive preexec boundary in Bash 4.4 and newer. On
# older Bash, use DEBUG only when doing so will not replace a user trap.
_treeport_title_integration_ready=
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  PS0='$(_treeport_command_start)'"\${PS0-}"
  _treeport_title_integration_ready=1
elif [[ -z "$(trap -p DEBUG)" ]]; then
  _treeport_uses_debug_trap=1
  _treeport_command_ready=0
  trap 'if [[ $_treeport_command_ready == 1 ]]; then _treeport_command_ready=0; _treeport_command_start "$BASH_COMMAND"; fi' DEBUG
  _treeport_title_integration_ready=1
fi
if [[ -n "$_treeport_title_integration_ready" ]]; then
  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
    PROMPT_COMMAND=(_treeport_command_end "\${PROMPT_COMMAND[@]}" _treeport_command_ready_prompt)
  else
    PROMPT_COMMAND="_treeport_command_end;\${PROMPT_COMMAND:+$PROMPT_COMMAND;}_treeport_command_ready_prompt"
  fi
fi
unset _treeport_title_integration_ready
if [[ -n "\${_treeport_uses_debug_trap-}" ]]; then
  _treeport_command_ready=1
fi
if [[ -n "\${TREEPORT_RUN_COMMAND+x}" ]]; then
  _treeport_run_command=$TREEPORT_RUN_COMMAND
  _treeport_run_after=\${TREEPORT_RUN_AFTER:-shell}
  _treeport_run_result=\${TREEPORT_RUN_RESULT-}
  unset TREEPORT_RUN_COMMAND TREEPORT_RUN_AFTER TREEPORT_RUN_RESULT
  _treeport_run_prompt() {
    [[ -n "\${_treeport_run_command+x}" ]] || return
    local run_command=$_treeport_run_command hook run_status
    unset _treeport_run_command
    builtin history -s -- "$run_command"
    _treeport_command_start "$run_command"
    for hook in preexec "\${preexec_functions[@]}"; do
      declare -F "$hook" >/dev/null && "$hook" "$run_command"
    done
    eval "$run_command"
    run_status=$?
    if [[ -n $_treeport_run_result ]]; then
      printf '%s\\n' "$run_status" >| "$_treeport_run_result.tmp" && command mv -f -- "$_treeport_run_result.tmp" "$_treeport_run_result"
    fi
    if [[ $_treeport_run_after == close || ( $_treeport_run_after == closeOnSuccess && $run_status == 0 ) ]]; then
      exit "$run_status"
    fi
    (exit "$run_status")
    _treeport_command_end
  }
  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
    PROMPT_COMMAND=("\${PROMPT_COMMAND[@]}" _treeport_run_prompt)
  else
    PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND;}_treeport_run_prompt"
  fi
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

# User config loads after vendor config and may prepend another treeport; keep this server's CLI first.
function _treeport_cli_path
  set -q TREEPORT_CLI_ENTRYPOINT; or return
  set -l cli_dir (string replace -r '/[^/]*$' '' -- $TREEPORT_CLI_ENTRYPOINT)
  test "$PATH[1]" = "$cli_dir"; or set -gx PATH $cli_dir $PATH
end

function _treeport_command_start --on-event fish_preexec
  set -l line (string replace -ar '[[:cntrl:]]' '' -- "$argv[1]" | string replace -a % %25 | string replace -a ';' %3B)
  printf '\\e]133;C;cmdline_url=%s\\e\\\\' "$line"
end

function _treeport_command_end --on-event fish_postexec
  printf '\\e]133;D;%s\\e\\\\' $status
end

function _treeport_prompt_start --on-event fish_prompt
  _treeport_cli_path
  # A directory or host name with a raw ESC or BEL could end OSC 7 early and inject its own sequence.
  printf '\\e]7;kitty-shell-cwd://%s%s\\e\\\\\\e]133;A\\e\\\\' (prompt_hostname | string replace -ar '[[:cntrl:]]' '') (string replace -ar '[[:cntrl:]]' '' -- "$PWD")
  # The prompt function runs after this event, so wrap it once user config has loaded.
  if not functions -q _treeport_user_prompt; and functions -q fish_prompt
    functions -c fish_prompt _treeport_user_prompt
    function fish_prompt
      _treeport_user_prompt
      printf '\\e]133;B\\e\\\\'
    end
  end
end

if set -q TREEPORT_RUN_COMMAND
  set -g _treeport_run_command $TREEPORT_RUN_COMMAND
  set -g _treeport_run_after shell
  set -q TREEPORT_RUN_AFTER; and set _treeport_run_after $TREEPORT_RUN_AFTER
  set -g _treeport_run_result
  set -q TREEPORT_RUN_RESULT; and set _treeport_run_result $TREEPORT_RUN_RESULT
  set -e TREEPORT_RUN_COMMAND TREEPORT_RUN_AFTER TREEPORT_RUN_RESULT

  function _treeport_run_prompt --on-event fish_prompt
    set -q _treeport_run_command; or return
    _treeport_cli_path
    set -l run_command $_treeport_run_command
    set -e _treeport_run_command
    builtin history append -- $run_command 2>/dev/null
    emit fish_preexec $run_command
    eval $run_command
    set -l run_status $status
    emit fish_postexec $run_command
    if test -n "$_treeport_run_result"
      printf '%s\\n' $run_status >"$_treeport_run_result.tmp"; and command mv -f -- "$_treeport_run_result.tmp" "$_treeport_run_result"
    end
    if test "$_treeport_run_after" = close; or begin; test "$_treeport_run_after" = closeOnSuccess; and test $run_status -eq 0; end
      exit $run_status
    end
  end
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
  integrated: boolean
}

export function integrateShellLaunch(
  argv: string[],
  env: NodeJS.ProcessEnv,
  root: string | undefined,
  enabled: boolean
): ShellLaunch {
  const shell = path.basename(argv[0] ?? '').replace(/^-/, '')

  if (!root || !enabled || !['zsh', 'bash', 'fish'].includes(shell)) {
    return { argv, env, integrated: false }
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
      return { argv, env, integrated: false }
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
      return { argv, env, integrated: false }
    }

    return {
      argv,
      env: {
        ...integratedEnv,
        TREEPORT_USER_ZDOTDIR: userZdotDir,
        ZDOTDIR: integrationZdotDir
      },
      integrated: true
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

    return { argv, env: fishEnvironment, integrated: true }
  }

  positional = false

  for (const argument of argv.slice(1)) {
    if (positional) {
      if (argument !== '-') {
        return { argv, env, integrated: false }
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
      return { argv, env, integrated: false }
    } else if (!argument.startsWith('-') && argument !== '-') {
      return { argv, env, integrated: false }
    }
  }

  const userHome = env.HOME?.trim()

  if (!userHome) {
    return { argv, env, integrated: false }
  }

  return {
    argv,
    env: {
      ...integratedEnv,
      HOME: path.join(root, 'bash', 'home'),
      TREEPORT_USER_HOME: userHome
    },
    integrated: true
  }
}

let input = ''

for await (const chunk of process.stdin) {
  input += chunk
}

if (!process.env.TREEPORT_TERMINAL_ID) {
  process.exit(0)
}

if (process.argv[2] === 'context') {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          'You are running in a Treeport-managed terminal. Use the treeport skill for persistent terminals, shared browser tabs, projects, and separate trees. Run treeport context before Treeport operations to read the current tree, assigned task, and target instance. Only act on a tree task when the user asks. Do not stop the inherited Treeport daemon or delete this terminal.'
      }
    }) + '\n'
  )
} else if (JSON.parse(input).tool_input?.run_in_background === true) {
  // EXTERNAL: Background shells are hidden from the user and die with this session.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'In Treeport, start long-running processes such as servers and watchers in a persistent Treeport terminal: treeport terminal create --worktree . --name "<name>" -- <program> <arg> ... Observe it with treeport terminal capture or treeport terminal wait, and delete it once it is no longer needed. See the treeport skill.'
      }
    }) + '\n'
  )
}

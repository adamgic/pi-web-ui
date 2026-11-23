// Built-in Pi 1.6 commands, plus browser controls. Runtime prompts, skills and
// extension commands are merged in by the bridge without exposing source paths.
export const builtinCommands = [
  ['help', 'Browse commands and keyboard shortcuts'],
  ['model', 'Choose an available model', '[provider/model]'],
  ['thinking', 'Choose reasoning effort', '[level]'],
  ['new', 'Start a new session'],
  ['resume', 'Choose a saved session'],
  ['tree', 'Navigate the session tree'],
  ['fork', 'Fork from a previous user message'],
  ['clone', 'Duplicate the current session at its current position'],
  ['name', 'Rename this session', '[name]'],
  ['session', 'Show session information and usage'],
  ['compact', 'Summarize older context', '[instructions]'],
  ['abort', 'Stop the current operation'],
  ['copy', 'Copy the last assistant response'],
  ['export', 'Download the session as HTML or JSONL', '[filename.html|filename.jsonl]'],
  ['tools', 'Enable or disable available tools'],
  ['settings', 'Inspect effective settings; edit them in Pi'],
  ['scoped-models', 'Inspect the model cycle; configure it in Pi'],
  ['changelog', 'Read the installed Pi changelog'],
  ['hotkeys', 'Show browser keyboard shortcuts'],
  ['login', 'Configure provider authentication in Pi', '[provider]', 'terminal'],
  ['logout', 'Remove provider authentication in Pi', '', 'terminal'],
  ['import', 'Import a JSONL session in Pi', '[path]', 'terminal'],
  ['share', 'Publish a session using Pi’s sharing dialog', '', 'terminal'],
  ['bug', 'Report a bug using Pi’s terminal workflow', '[description]', 'terminal'],
  ['trust', 'Manage project trust in Pi', '', 'terminal'],
  ['reload', 'Reload Pi resources in the terminal', '', 'terminal'],
  ['quit', 'Shut down Pi and this web server'],
].map(([name, description, argumentsHint = '', mode = 'browser']) => ({ name, description, argumentsHint, mode, source: 'builtin' }));

export function commandCatalog(commands = []) {
  const names = new Set(builtinCommands.map(item => item.name));
  return [...builtinCommands, ...commands.filter(item => {
    if (!item.name || names.has(item.name) || item.name === 'web-session') return false;
    names.add(item.name); return true;
  }).map(({ name, description, source }) => ({
    name, description: description || `${source} command`, source,
    mode: source === 'extension' ? 'terminal' : 'prompt', argumentsHint: '[arguments]',
  }))];
}

export function parseSlash(text) {
  const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1], args: (match[2] || '').trim() } : undefined;
}

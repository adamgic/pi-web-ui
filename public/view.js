/** Browser-safe projections of Pi's ordinary session entries and live events. */
export function textContent(content) {
  if (typeof content === 'string') return content;
  return (content || []).map(block => block.type === 'text' ? block.text : block.type === 'image' ? '[Image]' : '').join('');
}

export function usageOf(view) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: view.context?.tokens };
  for (const message of [...view.entries.filter(entry => entry.type === 'message').map(entry => entry.message), ...view.completed]) {
    if (message.role !== 'assistant' || !message.usage) continue;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) total[key] += message.usage[key] || 0;
    total.cost += message.usage.cost?.total || 0;
  }
  return total;
}

export function transcriptOf(view) {
  const items = [];
  const calls = new Map();
  function add(message, key, streaming = false) {
    if (message.role === 'system' || (message.role === 'custom' && message.display === false)) return;
    if (message.role === 'toolResult') {
      let tool = calls.get(message.toolCallId);
      if (!tool) { tool = { key, type: 'tool', name: message.toolName }; items.push(tool); calls.set(message.toolCallId, tool); }
      Object.assign(tool, { status: message.isError ? 'error' : 'done', output: textContent(message.content) });
      return;
    }
    if (message.role !== 'assistant') {
      items.push({ key, type: message.role === 'user' ? 'user' : 'notice', text: textContent(message.content) });
      return;
    }
    items.push({ key, type: 'assistant', text: textContent(message.content),
      thinking: message.content.filter(block => block.type === 'thinking').map(block => block.thinking).join('\n'),
      streaming, error: message.errorMessage || (['error', 'aborted'].includes(message.stopReason) ? message.stopReason : '') });
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      const tool = { key: `${key}:${block.id}`, type: 'tool', name: block.name, args: block.arguments,
        status: streaming ? 'preparing' : message.stopReason === 'toolUse' ? 'pending' : 'not run' };
      calls.set(block.id, tool); items.push(tool);
    }
  }
  for (const entry of view.entries) {
    if (entry.type === 'message') add(entry.message, entry.id);
    else if (entry.type === 'custom_message' && entry.display) add({ role: 'custom', content: entry.content }, entry.id);
    else if (entry.type === 'compaction' || entry.type === 'branch_summary') items.push({ key: entry.id, type: 'compaction', text: entry.summary });
  }
  view.completed.forEach((message, index) => add(message, `pending:${index}`));
  if (view.streaming) add(view.streaming, 'streaming', true);
  for (const slot of view.tools) {
    let tool = calls.get(slot.callId);
    if (!tool) { tool = { key: `live:${slot.callId}`, type: 'tool', name: slot.name }; items.push(tool); }
    if (['done', 'error'].includes(tool.status)) continue;
    Object.assign(tool, { status: slot.status, args: slot.args ?? tool.args, output: slot.output ?? tool.output });
  }
  return items;
}

export function formatDuration(milliseconds) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}h ${minutes}m ${seconds % 60}s` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

#!/bin/bash
# View OpenClaw session transcripts on the VPS
# Usage:
#   ./scripts/view-session.sh                    # Latest main agent session
#   ./scripts/view-session.sh --agent code       # Latest code agent session
#   ./scripts/view-session.sh --list             # List recent sessions
#   ./scripts/view-session.sh --id <session-id>  # Specific session
#   ./scripts/view-session.sh --agent main --list # List main agent sessions
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/../openclaw-config.env"

export TERM=xterm-256color
SSH_CMD="ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP}"

AGENT="main"
SESSION_ID=""
LIST_MODE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) AGENT="$2"; shift 2 ;;
    --id) SESSION_ID="$2"; shift 2 ;;
    --list) LIST_MODE=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

SESSIONS_DIR="/home/openclaw/.openclaw/agents/${AGENT}/sessions"

if $LIST_MODE; then
  $SSH_CMD "sudo python3 -c \"
import json, os, glob, datetime

files = glob.glob('${SESSIONS_DIR}/*.jsonl')
files.sort(key=os.path.getmtime, reverse=True)

for f in files[:15]:
    sid = os.path.basename(f).replace('.jsonl', '')
    mtime = datetime.datetime.fromtimestamp(os.path.getmtime(f)).strftime('%Y-%m-%d %H:%M')
    lines = sum(1 for _ in open(f))
    # Get first user message as preview
    preview = ''
    with open(f) as fh:
        for line in fh:
            d = json.loads(line)
            if d.get('type') == 'message':
                msg = d['message']
                if msg.get('role') == 'user':
                    c = msg.get('content', '')
                    if isinstance(c, list):
                        c = next((p.get('text','') for p in c if p.get('type')=='text'), '')
                    preview = c[:60].replace(chr(10), ' ')
                    break
    print(f'{mtime}  {sid[:12]}...  {lines:>4} lines  {preview}')
\""
  exit 0
fi

if [[ -z "$SESSION_ID" ]]; then
  # Find latest session by mtime
  SESSION_ID=$($SSH_CMD "sudo bash -c 'ls -t ${SESSIONS_DIR}/*.jsonl 2>/dev/null | head -1 | xargs -I{} basename {} .jsonl'")
fi

if [[ -z "$SESSION_ID" ]]; then
  echo "No sessions found for agent: ${AGENT}"
  exit 1
fi

SESSION_FILE="${SESSIONS_DIR}/${SESSION_ID}.jsonl"

$SSH_CMD "sudo python3 -c \"
import json, textwrap

with open('${SESSION_FILE}') as f:
    lines = f.readlines()

# Header
for line in lines[:3]:
    d = json.loads(line)
    if d.get('type') == 'session':
        print(f'Session: ${SESSION_ID}')
        print(f'Agent:   ${AGENT}')
        ts_val = d.get('timestamp') or '?'
        print(f'Time:    {ts_val}')
        print()
    elif d.get('type') == 'model_change':
        prov = d.get('provider') or '?'
        model = d.get('modelId') or '?'
        print(f'Model:   {prov}:{model}')
        print('─' * 80)
        print()

# Messages
for line in lines:
    d = json.loads(line)
    if d.get('type') != 'message':
        continue

    msg = d['message']
    role = msg.get('role', '?')
    content = msg.get('content', '')
    ts = d.get('timestamp', '')

    if isinstance(content, str):
        parts = [{'type': 'text', 'text': content}]
    elif isinstance(content, list):
        parts = content
    else:
        continue

    # Role header
    if role == 'user':
        print(f'┌─ USER ({ts})')
    elif role == 'assistant':
        print(f'┌─ ASSISTANT ({ts})')
    elif role == 'toolResult':
        print(f'┌─ TOOL RESULT')
    else:
        print(f'┌─ {role.upper()} ({ts})')

    for part in parts:
        ptype = part.get('type', '?')

        if ptype == 'text':
            text = part.get('text', '')
            if not text:
                continue
            # Indent and wrap
            for pline in text.split(chr(10)):
                print(f'│ {pline}')

        elif ptype == 'thinking':
            text = part.get('text', '')
            if text:
                preview = text[:200].replace(chr(10), ' ')
                print(f'│ [thinking] {preview}...' if len(text) > 200 else f'│ [thinking] {preview}')

        elif ptype == 'toolCall':
            name = part.get('name', '?')
            args = part.get('arguments', part.get('input', part.get('args', {})))
            args_str = json.dumps(args)
            if len(args_str) > 300:
                args_str = args_str[:300] + '...'
            print(f'│ [tool:{name}] {args_str}')

        elif ptype == 'tool_use':
            name = part.get('name', '?')
            inp = part.get('input', {})
            inp_str = json.dumps(inp)
            if len(inp_str) > 300:
                inp_str = inp_str[:300] + '...'
            print(f'│ [tool:{name}] {inp_str}')

        elif ptype == 'tool_result':
            content_val = part.get('content', '')
            if isinstance(content_val, str) and len(content_val) > 300:
                content_val = content_val[:300] + '...'
            print(f'│ [result] {content_val}')

    print('└' + '─' * 79)
    print()
\""

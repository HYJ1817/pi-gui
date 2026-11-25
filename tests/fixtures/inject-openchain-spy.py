# Diagnostic open-chain spy injection for the RUNTIME COPY of files-panel.js only.
# Never applied to source or the byte-identical verification tree. Patches in place.
import sys, io

src_path = sys.argv[1]
with io.open(src_path, 'r', encoding='utf-8') as f:
    src = f.read()
orig_len = len(src)

# Module-scope trace bootstrap after the state import.
spyinit = (
    "\nconst __oc=(typeof window!=='undefined')?(window.__openChain=window.__openChain||[]):null;"
    "const __push=(ev)=>{if(__oc)__oc.push({time:(typeof performance!=='undefined'?performance.now():0),...ev})};\n"
)
if '__oc=' not in src:
    marker = "import { S } from './state.js';"
    idx = src.index(marker) + len(marker)
    src = src[:idx] + spyinit + src[idx:]

def sub(old, new, tag):
    global src
    assert old in src, 'anchor missing: ' + tag
    assert src.count(old) == 1, 'anchor not unique: ' + tag
    src = src.replace(old, new, 1)

# 1. openFromReference entry
sub(
    "  async function openFromReference(source) {\n    if (!isCurrent() || !source",
    "  async function openFromReference(source) {\n    __push({ev:'ofr:entry',path:source&&source.path,openSequence,activeKey});\n    if (!isCurrent() || !source",
    'ofr-entry')

# 2. metadata outcome + guards in openFromReference
sub(
    "    const result = await metadata(request);\n    if (!scopeCurrent(run) || sequence !== openSequence) return;\n    if (!result?.ok) { toast('文件不存在、已变化或当前无法读取。', 'warn'); return; }\n    openTab(result.request);",
    "    const result = await metadata(request);\n    __push({ev:'ofr:metaDone',path:request.path,ok:!!(result&&result.ok),code:result&&result.code,scopeOk:scopeCurrent(run),seqMatch:sequence===openSequence,sequence,openSequence,activeKey});\n    if (!scopeCurrent(run) || sequence !== openSequence) return;\n    if (!result?.ok) { toast('文件不存在、已变化或当前无法读取。', 'warn'); return; }\n    openTab(result.request);",
    'ofr-metadone')

# 3. activate validation outcome + guards
sub(
    "    const result = target?.source === 'attachment' ? { ok: true } : await metadata(target, { restore: true });\n      if (!isVisible() || !scopeCurrent(run) || previewSequence !== sequence || openSequence !== intent || activeTab() !== tab) return;",
    "    const result = target?.source === 'attachment' ? { ok: true } : await metadata(target, { restore: true });\n      __push({ev:'act:validateDone',path:tab.request.path,ok:!!(result&&result.ok),code:result&&result.code,visOk:isVisible(),scopeOk:scopeCurrent(run),seqMatch:previewSequence===sequence,intentMatch:openSequence===intent,stillActive:activeTab()===tab,activeKey});\n      if (!isVisible() || !scopeCurrent(run) || previewSequence !== sequence || openSequence !== intent || activeTab() !== tab) return;",
    'act-validate')

# 4. activate activeKey assignment
sub(
    "    const tab = tabs.find((item) => item.key === key);\n    if (!tab) return;\n    disposePreview();\n    activeKey = key;",
    "    const tab = tabs.find((item) => item.key === key);\n    if (!tab) return;\n    disposePreview();\n    activeKey = key;\n    __push({ev:'act:setActive',path:tab.request.path,needsValidation:!!tab.needsValidation});",
    'act-setactive')

# 5. restoreTabs chosen key
sub(
    "    const current = activeTab();\n    const key = current ? current.key\n      : tabs.some((tab) => tab.key === value.active) ? value.active\n      : (existing.size ? null : tabs[0].key);",
    "    const current = activeTab();\n    const key = current ? current.key\n      : tabs.some((tab) => tab.key === value.active) ? value.active\n      : (existing.size ? null : tabs[0].key);\n    __push({ev:'restore:choose',chosen:key,hadCurrent:!!current,currentPath:current&&current.request.path,snapActive:value.active,incomingCount:incoming.length});",
    'restore-choose')

# 6. visibility subscriber: log every firing with the transition decision
sub(
    "    const next = typeof shown === 'boolean' ? shown : view.isVisible?.() !== false;\n    if (!alive || next === visible) return;\n    visible = next;\n    openSequence++; cancelMetadata();",
    "    const next = typeof shown === 'boolean' ? shown : view.isVisible?.() !== false;\n    __push({ev:'vis:fire',shown,next,visible,bumped:!( !alive || next===visible ),openSequence});\n    if (!alive || next === visible) return;\n    visible = next;\n    openSequence++; cancelMetadata();",
    'vis-fire')

# 7. reset entry: log scope resets that bump openSequence, with before/after identity
sub(
    "    if (!alive) return;\n    persistNow();\n    scopeEpoch++; openSequence++; cancelMetadata(); disposePreview();",
    "    if (!alive) return;\n    __push({ev:'reset:fire',type:event&&event.type,openSequence,beforeCwd:identity.cwd,beforeSess:identity.sessionId,beforeConv:identity.conversationId,afterCwd:effectiveIdentity().cwd,afterSess:effectiveIdentity().sessionId,afterConv:effectiveIdentity().conversationId});\n    persistNow();\n    scopeEpoch++; openSequence++; cancelMetadata(); disposePreview();",
    'reset-fire')

# 8. initial visible value + mount identity at mount
sub(
    "  let visible = view.isVisible?.() !== false;",
    "  let visible = view.isVisible?.() !== false;\n  __push({ev:'mount:init',visibleInit:visible,isVisibleNow:!!view.isVisible?.(),mountCwd:identity.cwd,mountSess:identity.sessionId,mountConv:identity.conversationId});",
    'mount-init')

with io.open(src_path, 'w', encoding='utf-8') as f:
    f.write(src)
print('patched OK %d -> %d' % (orig_len, len(src)))

export function requestId(cryptoApi = globalThis.crypto) {
    const bytes = new Uint8Array(24);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function mergeTurns(current, incoming, older = false) {
    const updates = new Map(incoming.map(turn => [turn.id, turn]));
    const known = new Set(current.map(turn => turn.id));
    const merged = current.map(turn => {
        const update = updates.get(turn.id);
        if (!update) return turn;
        const items = new Map(turn.items.map(item => [item.id, item]));
        for (const item of update.items) items.set(item.id, item);
        return { ...turn, ...update, items: [...items.values()] };
    });
    const added = incoming.filter(turn => !known.has(turn.id));
    return older ? [...added, ...merged] : [...merged, ...added];
}

export function stateLabel(status) {
    if (status?.type === 'idle') return '待機中';
    if (status?.activeFlags?.includes('waitingOnApprovalOrInput')) return '承認・回答待ち';
    if (status?.activeFlags?.includes('waitingOnApproval')) return '承認待ち';
    if (status?.activeFlags?.includes('waitingOnUserInput')) return '質問待ち';
    if (status?.type === 'active') return '作業中';
    if (status?.type === 'systemError') return 'エラー';
    return '状態未確認';
}

export function currentSelection(selected, generation, id, captured) {
    return selected === id && generation === captured;
}

export function groupItems(items) {
    const groups = [];
    for (const item of items) {
        if (['userMessage', 'agentMessage', 'plan'].includes(item.type)) {
            groups.push({ id: item.id, type: 'message', items: [item] });
        } else {
            const previous = groups.at(-1);
            if (previous?.type === 'tools') previous.items.push(item);
            else groups.push({ id: `tools:${item.id}`, type: 'tools', items: [item] });
        }
    }
    return groups;
}

export function toolState(items) {
    const statuses = items.map(item => item.status);
    if (statuses.some(status => ['inProgress', 'running'].includes(status))) return '実行中';
    if (statuses.some(status => ['failed', 'declined'].includes(status))) return 'エラーあり';
    if (statuses.every(status => status === 'completed')) return '完了';
    return '状態未確認';
}

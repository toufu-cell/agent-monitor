function screenLines(ansi) {
    if (typeof ansi !== 'string') return null;
    ansi = ansi.replace(/\r\n/g, '\n');
    const lines = [[]];
    let dim = false, background = null;
    for (let offset = 0; offset < ansi.length;) {
        if (ansi[offset] === '\x1b') {
            const match = /^\x1b\[([\d;]*)m/.exec(ansi.slice(offset));
            if (!match) return null;
            const codes = match[1] ? match[1].split(';').map(Number) : [0];
            for (let i = 0; i < codes.length; i++) {
                const code = codes[i];
                if (code === 0) { dim = false; background = null; }
                else if (code === 2) dim = true;
                else if (code === 22) dim = false;
                else if (code === 49) background = null;
                else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) background = String(code);
                else if (code === 38 || code === 48) {
                    const length = codes[i + 1] === 2 ? 3 : codes[i + 1] === 5 ? 1 : 0;
                    const values = codes.slice(i + 2, i + 2 + length);
                    if (!length || values.length !== length || values.some(value => value < 0 || value > 255)) return null;
                    if (code === 48) background = codes.slice(i + 1, i + 2 + length).join(';');
                    i += length + 1;
                } else if (![1, 3, 4, 7, 9, 23, 24, 27, 29, 39].includes(code)
                    && !(code >= 30 && code <= 37) && !(code >= 90 && code <= 97)) return null;
            }
            offset += match[0].length;
            continue;
        }
        const char = String.fromCodePoint(ansi.codePointAt(offset));
        offset += char.length;
        if (char === '\n') lines.push([]);
        else if (/[\x00-\x1f\x7f-\x9f]/.test(char)) return null;
        else lines.at(-1).push({ char, dim, background });
    }
    return lines;
}

export function codexInputState(ansi) {
    const lines = screenLines(ansi);
    if (!lines) return 'unknown';
    const start = lines.findLastIndex(line => line[0]?.char === '›');
    if (start < 1) return 'unknown';
    const background = lines[start][0].background;
    const padding = line => line?.length >= 10 && line.every(cell => cell.char === ' ' && cell.background === background);
    if (!background || !padding(lines[start - 1])) return 'unknown';
    let end = start + 1;
    while (end < lines.length && !padding(lines[end])) end++;
    if (end >= lines.length || lines[end].length !== lines[start - 1].length) return 'unknown';
    // 入力欄の直後にある状態表示を最大3行まで認識する。表示形式の変更時は実画面で再確認する。
    const tail = lines.slice(end + 1);
    if (tail.some(line => line.some(cell => cell.background === background))) return 'unknown';
    const footer = tail.filter(line => line.some(cell => cell.char.trim()));
    if (!footer.length || footer.length > 3) return 'unknown';
    const content = lines.slice(start, end).flatMap((line, i) => i ? line : line.slice(1));
    if (!content.length || content.some(cell => cell.background !== background)) return 'unknown';
    if (content.some(cell => cell.char !== ' ' && !cell.dim)) return 'draft';
    return content.some(cell => cell.char !== ' ' && cell.dim) ? 'empty' : 'unknown';
}

export function claudeInputState(ansi) {
    const lines = screenLines(ansi);
    if (!lines) return 'unknown';
    const rule = line => line?.length >= 10 && line.every(cell => cell.char === '─');
    const end = lines.findLastIndex(rule);
    if (end < 2) return 'unknown';
    let start = end - 1;
    while (start >= 0 && !rule(lines[start])) start--;
    if (start < 0 || lines[start].length !== lines[end].length) return 'unknown';
    const input = lines.slice(start + 1, end);
    if (input[0]?.[0]?.char !== '❯' || input[0]?.[1]?.char !== '\u00a0') return 'unknown';
    const footer = lines.slice(end + 1).filter(line => line.some(cell => cell.char.trim()));
    if (!footer.length || footer.length > 3 || footer.some(line => line[0]?.char !== ' ' || line[1]?.char !== ' ')) return 'unknown';
    const content = input.flatMap((line, index) => index ? line : line.slice(2));
    if (content.some(cell => !cell.dim)) return 'draft';
    // 複数行の入力は下書きとして保護する。空欄は1行とdimのヒントだけで認識する。
    if (input.length !== 1) return 'draft';
    return 'empty';
}

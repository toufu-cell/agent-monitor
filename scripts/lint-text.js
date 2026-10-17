import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { JSDOM } from 'jsdom';

const globalRoot = execFileSync('npm', ['root', '--global'], { encoding: 'utf8' }).trim();
const requireGlobal = createRequire(join(globalRoot, 'textlint', 'package.json'));
const { parse } = requireGlobal('@babel/parser');
const { createLinter, loadTextlintrc } = requireGlobal('textlint');
const config = join(homedir(), '.codex/textlint');
const plain = createLinter({ descriptor: await loadTextlintrc({ configFilePath: join(config, 'textlintrc.json'), node_modulesDir: globalRoot }) });
const markdown = createLinter({ descriptor: await loadTextlintrc({ configFilePath: join(config, 'textlintrc-markdown.cjs'), node_modulesDir: globalRoot }) });
const fragments = [];
const sources = [];
const japanese = /[\u3040-\u30ff\u3400-\u9fff]/;
function add(file, line, text) {
    if (text.trim()) fragments.push({ file, line, text: text.trim() });
}
for (const directory of ['src', 'web', 'test', 'scripts']) {
    for (const name of await readdir(directory)) {
        if (!name.endsWith('.js')) continue;
        const file = `${directory}/${name}`;
        const source = await readFile(file, 'utf8');
        sources.push(file);
        const tree = parse(source, { sourceType: 'module' });
        function visit(value, parent) {
            if (!value || typeof value !== 'object') return;
            if (Array.isArray(value)) { value.forEach(child => visit(child, parent)); return; }
            if (value.type === 'StringLiteral') {
                const humanCall = parent?.type === 'CallExpression' && (parent.callee?.name === 'test' || parent.callee?.property?.name === 'test') && parent.arguments[0] === value;
                const humanError = parent?.type === 'NewExpression' && parent.callee?.name === 'Error';
                if ((japanese.test(value.value) || humanCall || humanError) && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(value.value)) add(file, value.loc.start.line, value.value);
            }
            if (value.type === 'TemplateLiteral') {
                const text = value.quasis.map(part => part.value.cooked).join('${value}');
                if (japanese.test(text)) add(file, value.loc.start.line, text);
            }
            for (const [key, child] of Object.entries(value)) {
                if (!['loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) visit(child, value);
            }
        }
        visit(tree);
        tree.comments.forEach(comment => add(file, comment.loc.start.line, comment.value));
    }
}
const htmlFile = 'web/index.html';
const htmlSource = await readFile(htmlFile, 'utf8');
const dom = new JSDOM(htmlSource, { includeNodeLocations: true });
sources.push(htmlFile);
for (const element of dom.window.document.querySelectorAll('*')) {
    const line = dom.nodeLocation(element)?.startLine || 1;
    for (const child of element.childNodes) {
        if (child.nodeType === 3 && japanese.test(child.textContent)) add(htmlFile, line, child.textContent);
    }
    for (const name of ['aria-label', 'placeholder', 'title', 'alt']) {
        if (element.hasAttribute(name)) add(htmlFile, line, element.getAttribute(name));
    }
}
dom.window.close();
const manifestFile = 'web/manifest.webmanifest';
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
sources.push(manifestFile);
for (const key of ['name', 'short_name']) add(manifestFile, 1, manifest[key]);
const results = [];
const readme = await markdown.lintText(await readFile('README.md', 'utf8'), 'README.md');
results.push({ file: 'README.md', line: 1, ...readme });
for (const [i, fragment] of fragments.entries()) {
    const result = await plain.lintText(fragment.text, `${fragment.file}-line-${fragment.line}-${i}.txt`);
    results.push({ ...fragment, ...result });
}
if (!fragments.length || results.some(result => !result.filePath)) throw new Error('Missing textlint coverage');
await mkdir('artifacts', { recursive: true });
const diagnostics = results.flatMap(result => result.messages.map(message => ({ source: result.file, sourceLine: result.line, ...message })));
const report = { sources: ['README.md', ...sources], fragments, checked: results.map(result => result.filePath), diagnostics };
await writeFile('artifacts/textlint-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ sources: report.sources, fragments: fragments.length, errors: diagnostics.filter(d => d.severity === 2).length, warnings: diagnostics.filter(d => d.severity === 1).length, diagnostics }));
if (diagnostics.some(d => d.severity === 2)) process.exitCode = 1;

import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function safeMarkdown(text, purifier = DOMPurify) {
    return purifier.sanitize(marked.parse(text || '', { breaks: true }), {
        ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
        ALLOWED_ATTR: ['href', 'title'],
        ALLOW_DATA_ATTR: false,
        ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:|#)/i,
    });
}

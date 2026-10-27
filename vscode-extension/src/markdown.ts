/**
 * Render the small markdown subset Claude's answers use into HTML for the panel. Deliberately not a
 * parser: fenced and inline code, bold, italic, links, bullet and numbered lists, headings and
 * rules. Anything else falls through as literal text.
 *
 * Two invariants carry the weight. Every character of model output is HTML-escaped before a single
 * tag is emitted, so an answer can never inject markup — the panel's CSP is the seatbelt, this is
 * the guarantee. And it is total: a half-written document renders as a well-formed tree, so the
 * panel can re-render on every streaming flush without ever showing broken HTML.
 */
export function renderMarkdown(md: string): string {
  const out: string[] = [];
  let fence: string[] | undefined;
  let list: 'ul' | 'ol' | undefined;
  let para: string[] | undefined;

  const closeParagraph = () => {
    if (para) {
      out.push(`<p>${inline(para.join('<br />'))}</p>`);
      para = undefined;
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = undefined;
    }
  };
  const closeFence = () => {
    if (fence) {
      out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
      fence = undefined;
    }
  };

  for (const line of md.split('\n')) {
    if (fence) {
      // Inline rules never run inside a fence, and the info string is dropped: with no highlighter,
      // emitting a language class would only add an attribute-injection surface.
      if (/^\s*```/.test(line)) {
        closeFence();
      } else {
        fence.push(line);
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      closeParagraph();
      closeList();
      fence = [];
      continue;
    }
    if (line.trim() === '') {
      closeParagraph();
      closeList();
      continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      closeParagraph();
      closeList();
      out.push('<hr class="md-hr" />');
      continue;
    }

    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      closeParagraph();
      closeList();
      // One weight for every level: a narrow panel has no room for six heading sizes.
      out.push(`<div class="md-h">${inline(escapeHtml(heading[1]))}</div>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      closeParagraph();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      // Nesting is flattened: indentation is ignored rather than half-supported.
      out.push(`<li>${inline(escapeHtml((bullet ?? numbered)![1]))}</li>`);
      continue;
    }

    closeList();
    (para ??= []).push(escapeHtml(line.trim()));
  }

  // Close everything still open, which is what makes a mid-stream render safe.
  closeFence();
  closeParagraph();
  closeList();
  return out.join('');
}

/**
 * Inline rules over already-escaped text, in one left-to-right pass with code first: a code span's
 * content is emitted and never revisited, so backticks win over emphasis inside them. Unpaired
 * delimiters simply do not match and stay literal, which is what a streaming answer looks like
 * until its closer arrives.
 *
 * The link pattern requires an http(s) URL, so `[x](javascript:…)` never matches at all. Links carry
 * `data-ext`, the panel's existing convention for "open this externally".
 */
function inline(escaped: string): string {
  return escaped.replace(
    /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*|(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (match, code, bold, star, underscore, text, href) => {
      if (code !== undefined) {
        return `<code>${code}</code>`;
      }
      if (bold !== undefined) {
        return `<strong>${bold}</strong>`;
      }
      if (star !== undefined) {
        return `<em>${star}</em>`;
      }
      if (underscore !== undefined) {
        return `<em>${underscore}</em>`;
      }
      if (text !== undefined && href !== undefined) {
        return `<a data-ext="${href}">${text}</a>`;
      }
      return match;
    },
  );
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

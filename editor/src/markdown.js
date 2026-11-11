// The Markdown the scene editor understands: CommonMark plus ~~strikethrough~~, parsed by
// @lezer/markdown. @codemirror/lang-markdown is not used because it also bundles the HTML,
// CSS and JavaScript languages for embedded code, which a manuscript does not need.
import { Language, LanguageSupport, defineLanguageFacet } from '@codemirror/language';
import { Strikethrough, parser as commonmark } from '@lezer/markdown';

export const parser = commonmark.configure([Strikethrough]);

const data = defineLanguageFacet({ commentTokens: { block: { open: '<!--', close: '-->' } } });

export const markdownLanguage = new Language(data, parser, [], 'markdown');

export function markdown() {
  return new LanguageSupport(markdownLanguage);
}

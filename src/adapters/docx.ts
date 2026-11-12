/**
 * A minimal WordprocessingML package (.docx) for a manuscript: no dependency, only
 * [Content_Types].xml, relationships, document, styles, numbering and core properties, zipped by
 * writeZip. The Markdown subset of the editor becomes paragraphs and runs; anything else stays text.
 */
import { readableParts, parseMarkdown, SCENE_BREAK_MARK, type Block, type ManuscriptPart, type Run } from '../domain/manuscript.ts';
import { writeZip } from './zip.ts';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** XML 1.0 forbids most control characters, so they are dropped; the five markup characters are escaped. */
export function xmlEscape(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textRuns(text: string, props: string): string {
  // A tab is a tab stop, not a character inside w:t; a newline inside a run is a line break.
  return text.split(/(\t|\n)/).filter((piece) => piece !== '').map((piece) => {
    const rpr = props ? `<w:rPr>${props}</w:rPr>` : '';
    if (piece === '\t') return `<w:r>${rpr}<w:tab/></w:r>`;
    if (piece === '\n') return `<w:r>${rpr}<w:br/></w:r>`;
    return `<w:r>${rpr}<w:t xml:space="preserve">${xmlEscape(piece)}</w:t></w:r>`;
  }).join('');
}

function runsXml(runs: Run[]): string {
  return runs.map((run) => {
    if (run.br) return '<w:r><w:br/></w:r>';
    const props = `${run.bold ? '<w:b/>' : ''}${run.italic ? '<w:i/>' : ''}${run.strike ? '<w:strike/>' : ''}`;
    return textRuns(run.text ?? '', props);
  }).join('');
}

function paragraph(style: string | null, runs: string, extra = ''): string {
  const ppr = `${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}`;
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${runs}</w:p>`;
}

function blockXml(block: Block, orderedNum: (listId: number) => number): string {
  switch (block.kind) {
    case 'heading': return paragraph(`Heading${Math.min(block.level, 3)}`, runsXml(block.runs));
    case 'paragraph': return paragraph(null, runsXml(block.runs));
    case 'quote': return paragraph('Quote', runsXml(block.runs));
    case 'break': return paragraph('SceneBreak', textRuns(SCENE_BREAK_MARK, ''));
    case 'list': {
      const numId = block.ordered ? orderedNum(block.listId) : 1;
      return paragraph('ListParagraph', runsXml(block.runs), `<w:numPr><w:ilvl w:val="${block.level}"/><w:numId w:val="${numId}"/></w:numPr>`);
    }
  }
}

const STYLES = `${XML_HEAD}<w:styles ${NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="3600" w:after="480"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="480" w:after="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="180"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="SceneBreak"><w:name w:val="Scene Break"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="240"/><w:jc w:val="center"/></w:pPr></w:style>
</w:styles>`;

function numbering(orderedLists: number): string {
  const levels = (kind: 'bullet' | 'decimal') => [0, 1, 2].map((l) =>
    `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${kind}"/><w:lvlText w:val="${kind === 'bullet' ? '•' : `%${l + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
  const nums = ['<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'];
  for (let n = 0; n < orderedLists; n++) {
    nums.push(`<w:num w:numId="${n + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`);
  }
  return `${XML_HEAD}<w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels('decimal')}</w:abstractNum>${nums.join('')}</w:numbering>`;
}

const CONTENT_TYPES = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;

const ROOT_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

const DOCUMENT_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`;

/** The .docx bytes of a manuscript: title page, a Heading 1 per titled part, scene breaks between scenes. */
export function buildDocx(title: string, outline: ManuscriptPart[]): Buffer {
  const listIds = new Map<number, number>();
  const orderedNum = (listId: number) => {
    if (!listIds.has(listId)) listIds.set(listId, listIds.size + 2);
    return listIds.get(listId)!;
  };
  const body: string[] = [paragraph('Title', runsXml([{ text: title }]))];
  let first = true;
  for (const part of readableParts(outline)) {
    if (part.title) {
      // A chapter starts on a new page; the first one also leaves the title page.
      body.push(paragraph('Heading1', runsXml([{ text: part.title }]), '<w:pageBreakBefore/>'));
    } else if (first) {
      body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    }
    first = false;
    part.texts.forEach((text, i) => {
      if (i > 0) body.push(blockXml({ kind: 'break' }, orderedNum));
      for (const block of parseMarkdown(text)) body.push(blockXml(block, orderedNum));
    });
  }
  const document = `${XML_HEAD}<w:document ${NS}><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const core = `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(title)}</dc:title></cp:coreProperties>`;
  const member = (name: string, xml: string) => ({ name, data: Buffer.from(xml, 'utf8') });
  return writeZip([
    member('[Content_Types].xml', CONTENT_TYPES),
    member('_rels/.rels', ROOT_RELS),
    member('word/document.xml', document),
    member('word/_rels/document.xml.rels', DOCUMENT_RELS),
    member('word/styles.xml', STYLES),
    member('word/numbering.xml', numbering(listIds.size)),
    member('docProps/core.xml', core),
  ]);
}

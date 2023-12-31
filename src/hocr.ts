import { Detail, SaxEventType, Tag, Text } from 'sax-wasm';
import {
  Dimensions,
  OcrBlock,
  OcrElement,
  OcrLine,
  OcrPage,
  OcrParagraph,
  OcrWord,
  Polygon,
  WordChoice,
  makeBlock,
  makeLine,
  makePage,
  makeParagraph,
} from './model.js';
import {
  getParser,
  toReadableStream,
  resolveXmlEntities,
  getAttributeValue,
  getAllAttributes,
  logWithPosition,
} from './util.js';
import { ReferenceSizeCallback } from '.';

type HocrAttribs = {
  [key: string]: string;
} & { bbox?: number[] };

/** Parse hOCR attributes from a node's title attribute */
function parseHocrAttribs(tag: Tag): HocrAttribs {
  const titleAttrib = getAttributeValue(tag, 'title');
  if (!titleAttrib) {
    return {};
  }
  const vals = titleAttrib.split(';').map((x) => x.trim());
  return vals.reduce((acc: HocrAttribs, val) => {
    const key = val.split(' ')[0];
    // Special handling for bounding boxes, convert them to a number[4]
    if (key === 'bbox') {
      acc[key] = val
        .split(' ')
        .slice(1, 5)
        .map((x: string) => Number.parseInt(x, 10));
    } else {
      acc[key] = val.split(' ').slice(1, 5).join(' ');
      if (acc[key].startsWith('"') && acc[key].endsWith('"')) {
        acc[key] = acc[key].slice(1, -1);
      }
    }
    return acc;
  }, {});
}

function parsePolygon(polyAttr: string, scaleFactor: number): Polygon {
  return polyAttr
    .split(' ')
    .map((x) => Number.parseFloat(x))
    .reduce((acc, c) => {
      const last = acc.slice(-1)[0];
      if (!last || last.length === 2) {
        acc.push([c]);
      } else {
        last.push(c);
      }
      return acc;
    }, [] as number[][])
    .map(([x, y]) => ({ x: scaleFactor * x, y: scaleFactor * y }));
}

async function handleChildren(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  allowedTypes: Set<HocrType | 'text'>,
  ctx: ParserContext,
): Promise<void> {
  let openTags = 0;
  let result: IteratorResult<[SaxEventType, Detail]>;

  // Handle all children of the current element
  while (openTags >= 0 && !(result = await eventIter.next()).done) {
    const [evt, data] = result.value;

    // Lines can have text nodes as children
    if (evt === SaxEventType.Text && allowedTypes.has('text')) {
      const parentElem = ctx.elementStack.slice(-1)[0];
      if (typeof parentElem !== 'string' && parentElem.type === 'line') {
        // Normalize multiple whitespace characters to a single one
        const txt = (data as Text).value.replace(/\s+/g, ' ');
        const whitespaceOnly = txt === ' ';
        // Don't add whitespace-only string at beginning or end of line and
        // skip consecutive whitespace-only strings
        if (
          (parentElem.children.length > 0 || !whitespaceOnly) &&
          !(parentElem.children.slice(-1)[0] === ' ' && whitespaceOnly)
        ) {
          parentElem.children.push(txt);
        }
      }
    }
    if (evt === SaxEventType.CloseTag) {
      openTags--;
    }

    if (evt !== SaxEventType.OpenTag) {
      continue;
    }
    openTags++;
    const tag = data as Tag;
    const hocrType = getHocrType(tag);
    if (hocrType === null) {
      continue;
    }
    if (!allowedTypes.has(hocrType)) {
      logWithPosition(
        `Unexpected hOCR element type: ${hocrType}, expected one of [${Array.from(
          allowedTypes,
        ).join(', ')}]`,
        'warn',
        tag,
      );
      continue;
    }
    switch (hocrType) {
      case 'block':
        await handleBlock(eventIter, tag, ctx);
        openTags--;
        break;
      case 'paragraph':
        await handleParagraph(eventIter, tag, ctx);
        openTags--;
        break;
      case 'line':
        await handleLine(eventIter, tag, ctx);
        openTags--;
        break;
      case 'word':
        await handleWord(eventIter, tag, ctx);
        openTags--;
        break;
      default:
        break;
    }
  }

  // If we're he're, we're done with the current element, so we can pop it off the stack
  ctx.elementStack.pop();
}

async function handlePage(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  tag: Tag,
  ctx: ParserContext,
  referenceSize?: Dimensions,
): Promise<OcrPage | null> {
  const hocrAttribs = parseHocrAttribs(tag);
  const pageSize = hocrAttribs.bbox as [number, number, number, number];
  ctx.scaleFactor = referenceSize
    ? determineScaleFactor(pageSize, referenceSize)
    : 1;
  const page = makePage({
    features: [],
    width: pageSize[2] * ctx.scaleFactor,
    height: pageSize[3] * ctx.scaleFactor,
  });
  if ('ppageno' in hocrAttribs) {
    page.physicalPageNumber = Number.parseInt(hocrAttribs.ppageno, 10);
  }
  if ('lpageno' in hocrAttribs) {
    page.logicalPageNumber = hocrAttribs.lpageno;
  }
  if ('image' in hocrAttribs) {
    page.imageSource = {
      fileName: hocrAttribs.image,
    };
  }
  if ('x_source' in hocrAttribs) {
    if (!page.imageSource) {
      page.imageSource = {};
    }
    page.imageSource.documentIdentifier = hocrAttribs.x_source;
  }
  if ('imagemd5' in hocrAttribs) {
    if (!page.imageSource) {
      page.imageSource = {};
    }
    page.imageSource.checksum = hocrAttribs.imagemd5;
    page.imageSource.checksumType = 'MD5';
  }
  if ('scan_res' in hocrAttribs) {
    if (!page.imageSource) {
      page.imageSource = {};
    }
    page.imageSource.ppi = Number.parseInt(hocrAttribs.scan_res.split(' ')[0], 10);
  }

  ctx.elementStack.push(page);
  await handleChildren(
    eventIter,
    new Set(['block', 'paragraph', 'line']),
    ctx,
  );
  for (const elem of ['blocks', 'paragraphs', 'lines'] as const) {
    if ((page[elem] ?? []).some((e) => e.polygon !== undefined)) {
      page.features.push('POLYGONS');
    }
  }
  if (page.words.some((w) => w.choices !== undefined)) {
    page.features.push('CHOICES');
  }
  if (page.words.some((w) => w.hyphenStart)) {
    page.features.push('HYPHEN');
  }
  if (page.words.some((w) => w.confidence !== undefined)) {
    page.features.push('CONFIDENCE');
  }
  return page;
}

async function handleBlock(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  tag: Tag,
  ctx: ParserContext,
): Promise<void> {
  const hocrAttribs = parseHocrAttribs(tag);
  const [ulx, uly, lrx, lry] = (hocrAttribs.bbox as number[]).map(
    (dim) => dim * ctx.scaleFactor,
  );
  const block = makeBlock({
    x: ulx,
    y: uly,
    width: lrx - ulx,
    height: lry - uly,
  });
  if ('poly' in hocrAttribs) {
    block.polygon = parsePolygon(hocrAttribs.poly, ctx.scaleFactor);
  }
  (ctx.elementStack.slice(-1)[0] as OcrPage).children.push(block);
  ctx.elementStack.push(block);
  await handleChildren(eventIter, new Set(['paragraph', 'line']), ctx);
}

async function handleParagraph(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  tag: Tag,
  ctx: ParserContext,
): Promise<void> {
  const hocrAttribs = parseHocrAttribs(tag);
  let x: number | undefined;
  let y: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  if (hocrAttribs.bbox) {
    const coords = (hocrAttribs.bbox as number[]).map(
      (dim) => dim * ctx.scaleFactor,
    );
    x = coords[0];
    y = coords[1];
    width = coords[2] - x;
    height = coords[3] - y;
  }
  const paragraph = makeParagraph({
    x,
    y,
    width,
    height,
  });
  if ('poly' in hocrAttribs) {
    paragraph.polygon = parsePolygon(hocrAttribs.poly, ctx.scaleFactor);
  }
  const parentElem = ctx.elementStack.slice(-1)[0] as OcrPage | OcrBlock;
  parentElem.children.push(paragraph);
  ctx.elementStack.push(paragraph);
  await handleChildren(eventIter, new Set(['line']), ctx);
}

async function handleLine(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  tag: Tag,
  ctx: ParserContext,
): Promise<void> {
  const parsedAttribs = parseHocrAttribs(tag);
  if (!('bbox' in parsedAttribs)) {
    logWithPosition('Missing bbox attribute on line element', 'warn', tag);
    return;
  }
  const [ulx, uly, lrx, lry] = (parsedAttribs.bbox as number[]).map(
    (dim) => dim * ctx.scaleFactor,
  );
  const line = makeLine({
    x: ulx,
    y: uly,
    width: lrx - ulx,
    height: lry - uly,
  });
  if ('poly' in parsedAttribs) {
    line.polygon = parsePolygon(parsedAttribs.poly, ctx.scaleFactor);
  }
  if ('baseline' in parsedAttribs) {
    const parts = parsedAttribs.baseline.split(' ');
    const slope = Number.parseFloat(parts[0]);
    const intercept = Number.parseInt(parts[1], 10);
    const ulx = line.x;
    const uly = line.y;
    line.baseline = [
      { x: ulx, y: uly + intercept },
      { x: ulx + line.width, y: uly + intercept + (line.width * slope) },
    ]
  }
  const parentElem = ctx.elementStack.slice(-1)[0] as
    | OcrPage
    | OcrBlock
    | OcrParagraph;
  parentElem.children.push(line);
  ctx.elementStack.push(line);

  await handleChildren(eventIter, new Set(['word', 'text']), ctx);

  // Strip whitespace from end of line
  if (line.children.slice(-1)[0] === ' ') {
    line.children = line.children.slice(0, -1);
  }

  // Normalize word confidences to [0, 1]
  const needsNormalization = line.words.some(
    w => w.confidence !== undefined && w.confidence > 1);
  if (needsNormalization) {
    // We're assuming a [0, 100] range for confidence values
    for (const word of line.words) {
      if (word.confidence !== undefined) {
        word.confidence /= 100;
      }
    }
  }
}

async function handleWord(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  tag: Tag,
  ctx: ParserContext,
): Promise<void> {
  const parsedAttribs = parseHocrAttribs(tag);
  const [ulx, uly, lrx, lry] = (parsedAttribs.bbox as number[]).map(
    (dim) => dim * ctx.scaleFactor,
  );

  let wordText: string = '';
  let wordChoices: WordChoice[] | undefined;

  let openTags = 0;
  // Read events until word element is closed
  while (openTags >= 0) {
    const result = await eventIter.next();
    if (result.done) {
      throw new Error('Unexpected end of stream while parsing word');
    }
    const [evt, data] = result.value;
    if (evt === SaxEventType.OpenTag) {
      openTags++;
      const tag = data as Tag;
      if (tag.name === 'span' && getHocrType(tag) === 'alternatives') {
        wordChoices = [];
      }
    } else if (evt === SaxEventType.CloseTag) {
      openTags--;
      const tag = data as Tag;
      // TODO: Handle ocrx_cinfo from Tesseract:
      // https://github.com/tesseract-ocr/tesseract/blob/main/src/api/hocrrenderer.cpp#L333-L397
      if (wordChoices && tag.name === 'ins') {
        wordText = tag.textNodes.map((t) => t.value.trim()).join('');
      } else if (wordChoices && tag.name === 'del') {
        const nlp = getAttributeValue(tag, 'nlp');
        const choice: WordChoice = {
          text: tag.textNodes.map((t) => t.value.trim()).join(''),
        };
        if (choice.text.includes('&')) {
          choice.text = resolveXmlEntities(choice.text);
        }
        if (nlp) {
          choice.probability = Math.exp(-Number.parseFloat(nlp));
        }
        wordChoices.push(choice);
      }
    } else if (evt === SaxEventType.Text && !wordChoices) {
      const txt = (data as Text).value;
      wordText += txt.trim();
    }
  }
  if (!wordText.length) {
    logWithPosition('Word element has no text, skipping.', 'debug', tag);
    return;
  }
  const word: OcrWord = {
    type: 'word',
    x: ulx,
    y: uly,
    width: lrx - ulx,
    height: lry - uly,
    text: wordText,
  };
  if (wordChoices?.length) {
    word.choices = wordChoices;
  }
  word.hyphenStart = word.text.endsWith('\u00AD');
  if (word.hyphenStart) {
    word.text = word.text.slice(0, -1);
  }
  if (word.text.includes('&')) {
    word.text = resolveXmlEntities(word.text);
  }
  if ('poly' in parsedAttribs) {
    word.polygon = parsePolygon(parsedAttribs.poly, ctx.scaleFactor);
  }
  if ('x_wconf' in parsedAttribs) {
    word.confidence = Number.parseFloat(parsedAttribs.x_wconf);
  }
  (ctx.elementStack.slice(-1)[0] as OcrLine).children.push(word);
}

function determineScaleFactor(
  pageSize: [number, number, number, number],
  referenceSize: Dimensions,
): number {
  if (
    pageSize[2] === referenceSize.width &&
    pageSize[3] === referenceSize.height
  ) {
    return 1;
  }
  const scaleFactorX = referenceSize.width / pageSize[2];
  const scaleFactorY = referenceSize.height / pageSize[3];
  const scaledWidth = Math.round(scaleFactorY * pageSize[2]);
  const scaledHeight = Math.round(scaleFactorX * pageSize[3]);
  if (
    scaledWidth !== referenceSize.width ||
    scaledHeight !== referenceSize.height
  ) {
    console.warn(
      `Differing scale factors for x and y axis while parsing hOCR, will use X factor: x=${scaleFactorX}, y=${scaleFactorY}`,
    );
  }
  return scaleFactorX;
}

type ParserContext = {
  scaleFactor: number;
  elementStack: OcrElement[];
};

type HocrType =
  | 'page'
  | 'block'
  | 'paragraph'
  | 'line'
  | 'word'
  | 'char'
  | 'alternatives'
  | 'alt';

function getHocrType(tag: Tag): HocrType | null {
  const hocrType = getAttributeValue(tag, 'class');
  switch (hocrType) {
    case 'ocr_page':
      return 'page';
    case 'ocr_carea':
    case 'ocrx_block':
      return 'block';
    case 'ocr_par':
      return 'paragraph';
    case 'ocr_line':
    case 'ocrx_line':
      return 'line';
    case 'ocrx_word':
      return 'word';
    case 'ocrx_cinfo':
      return 'char';
    case 'alternatives':
      return 'alternatives';
    case 'alt':
      return 'alt';
    default:
      return null;
  }
}

/**
 * Parse an hOCR document.
 *
 * @param hocr The hOCR document to parse. Can be a `string`, a `Uint8Array` or
 *   a `ReadableStream`.
 * @param referenceSizes An array of pixel dimensions for each page in the
 *   document, or a callback that returns the dimensions for a given page,
 *   based on its numerical index and its XML attributes. These dimensions can
 *   be used to scale all coordinates to a given reference frame in cases when
 *   the display resolution is different from the OCR resolution.
 * @returns An async generator that yields `OcrPage` objects.
 */
export async function* parseHocrPages(
  hocr: ReadableStream<Uint8Array> | Uint8Array | string,
  referenceSizes?: Dimensions[] | ReferenceSizeCallback,
): AsyncGenerator<OcrPage> {
  if (Array.isArray(referenceSizes)) {
    const sizeArr = referenceSizes;
    referenceSizes = (idx: number) => sizeArr[idx] ?? null;
  }
  const readable: ReadableStream<Uint8Array> =
    typeof hocr === 'string' || hocr instanceof Uint8Array
      ? toReadableStream(hocr)
      : hocr;
  const parser = await getParser(readable);
  const ctx: ParserContext = {
    scaleFactor: 1,
    elementStack: [],
  };
  let pageIdx = 0;
  const eventIter = parser.iterate();
  let result: IteratorResult<[SaxEventType, Detail]>;
  while (!(result = await eventIter.next()).done) {
    const [evt, data] = result.value;

    // Handlers advance the iterator themselves until they're done with their
    // respective element, this entry level just needs to recognize the
    // beginning of the page element and then hand over to the page handler
    // function.

    if (
      evt !== SaxEventType.OpenTag ||
      (data as Tag).name !== 'div' ||
      getHocrType(data as Tag) !== 'page'
    ) {
      continue;
    }

    const page = await handlePage(
      eventIter,
      data as Tag,
      ctx,
      referenceSizes?.(pageIdx, getAllAttributes(data as Tag)) ?? undefined,
    );
    if (!page) {
      continue;
    }
    yield page;
  }
}

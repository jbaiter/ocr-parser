import { Detail, SaxEventType, Tag } from 'sax-wasm';
import {
  Dimensions,
  OcrBlock,
  OcrElement,
  OcrLine,
  OcrPage,
  OcrWord,
  Polygon,
  makeBlock,
  makeLine,
  makePage,
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

type ParserContext = {
  scaleFactor: number;
  elementStack: OcrElement[];
  sourceImageInformation?: OcrPage['imageSource'];
};

const NUMERIC_ATTRIBS = ['HEIGHT', 'WIDTH', 'HPOS', 'VPOS', 'WC'];

function getAttributes(
  data: Tag,
  names?: string[],
): Record<string, string | number> {
  return Object.fromEntries(
    data.attributes
      .filter((attr) => !names || names.includes(attr.name.value))
      .map((attr) => [
        attr.name.value,
        NUMERIC_ATTRIBS.includes(attr.name.value)
          ? Number.parseFloat(attr.value.value)
          : attr.value.value,
      ]),
  );
}

function getCoordinates(
  data: Tag,
): Partial<{ height: number; width: number; x: number; y: number }> {
  const attrs = getAttributes(data, ['HEIGHT', 'WIDTH', 'HPOS', 'VPOS']);
  return {
    height: attrs.HEIGHT as number | undefined,
    width: attrs.WIDTH as number | undefined,
    x: attrs.HPOS as number | undefined,
    y: attrs.VPOS as number | undefined,
  };
}

async function handlePage(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  ctx: ParserContext,
  tag: Tag,
  referenceSize?: Dimensions,
): Promise<OcrPage | null> {
  const dims = getCoordinates(tag);
  if (!dims.width || !dims.height) {
    throw new Error('Could not get Page dimensions');
  }
  const scaleFactorX = referenceSize ? referenceSize.width / dims.height! : 1;
  const scaleFactorY = referenceSize ? referenceSize.height / dims.width! : 1;
  if (scaleFactorX !== scaleFactorY) {
    console.warn(
      `Scale factors differ: x=${scaleFactorX} vs y=${scaleFactorY}, using X scale factor.`,
    );
  }
  ctx.scaleFactor = scaleFactorX;
  const page = makePage({
    features: [],
    width: dims.width * scaleFactorX,
    height: dims.height * scaleFactorX,
  });
  ctx.elementStack.push(page);

  const pageAttribs = getAllAttributes(tag);
  if ('PHYSICAL_IMG_NR' in pageAttribs) {
    page.physicalPageNumber = Number.parseInt(pageAttribs.PHYSICAL_IMG_NR);
  }
  if ('PRINTED_IMG_NR' in pageAttribs) {
    page.logicalPageNumber = pageAttribs.PRINTED_IMG_NR;
  }

  let openTags = 0;
  let result: IteratorResult<[SaxEventType, Detail]>;
  while (openTags >= 0 && !(result = await eventIter.next()).done) {
    const [evt, data] = result.value;
    if (evt === SaxEventType.CloseTag) {
      openTags--;
    } else if (evt !== SaxEventType.OpenTag) {
      continue;
    }

    openTags++;
    const tag = data as Tag;
    if (tag.name === 'TextBlock') {
      await handleBlock(eventIter, ctx, data as Tag);
    }
  }
  ctx.elementStack.pop();
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
  if (ctx.sourceImageInformation) {
    page.imageSource = ctx.sourceImageInformation;
    // Source Image information only applies to the first page in a file, all further pages
    // are undefined, as far as I can tell from the ALTO XSD.
    ctx.sourceImageInformation = undefined;
  }
  return page;
}

async function handleBlock(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  ctx: ParserContext,
  tag: Tag,
): Promise<void> {
  const dims = getCoordinates(tag);
  const block = makeBlock({
    x: dims.x ? dims.x! * ctx.scaleFactor : -1,
    y: dims.y ? dims.y! * ctx.scaleFactor : -1,
    width: dims.width ? dims.width * ctx.scaleFactor : -1,
    height: dims.height ? dims.height * ctx.scaleFactor : -1,
  });
  (ctx.elementStack.slice(-1)[0] as OcrPage).children.push(block);
  ctx.elementStack.push(block);

  let openTags = 0;
  let result: IteratorResult<[SaxEventType, Detail]>;
  while (openTags >= 0 && !(result = await eventIter.next()).done) {
    const [evt, data] = result.value;
    if (evt === SaxEventType.CloseTag) {
      openTags--;
    } else if (evt !== SaxEventType.OpenTag) {
      continue;
    }

    openTags++;
    const tag = data as Tag;
    if (tag.name === 'TextLine') {
      await handleLine(eventIter, ctx, data as Tag);
    } else if (tag.name === 'Shape') {
      const polygon = await handleShape(eventIter, ctx, tag);
      if (polygon != null) {
        block.polygon = polygon;
      }
    }
  }
  ctx.elementStack.pop();
}

async function handleLine(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  ctx: ParserContext,
  tag: Tag,
): Promise<void> {
  const dims = getCoordinates(tag);
  const line = makeLine({
    x: dims.x ? dims.x * ctx.scaleFactor : -1,
    y: dims.y ? dims.y * ctx.scaleFactor : -1,
    width: dims.width ? dims.width * ctx.scaleFactor : -1,
    height: dims.height ? dims.height * ctx.scaleFactor : -1,
  });
  (ctx.elementStack.slice(-1)[0] as OcrBlock).children.push(line);
  ctx.elementStack.push(line);

  let openTags = 0;
  let result: IteratorResult<[SaxEventType, Detail]>;
  while (openTags >= 0 && !(result = await eventIter.next()).done) {
    const [evt, data] = result.value;
    if (evt === SaxEventType.CloseTag) {
      openTags--;
    }
    if (evt !== SaxEventType.OpenTag) {
      continue;
    }

    openTags++;
    const tag = data as Tag;
    if (tag.name === 'String') {
      await handleWord(eventIter, ctx, data as Tag);
      // Words handle their closing themselves
      openTags--;
    } else if (tag.name === 'SP') {
      line.children.push(' ');
    } else if (tag.name === 'Shape') {
      const polygon = await handleShape(eventIter, ctx, tag);
      if (polygon != null) {
        line.polygon = polygon;
      }
    }
  }
  ctx.elementStack.pop();

  // Check if spaces are explicitely encoded
  if (!line.children.find((c) => c === ' ')) {
    // Add spaces between words, except for last word on line
    line.children = line.children.flatMap((c, i) =>
      i === line.children.length - 1 ? [c] : [c, ' '],
    );
  }
}

async function handleShape(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  ctx: ParserContext,
  tag: Tag,
): Promise<Polygon | null> {
  let polygon: Polygon | null = null;
  let openTags = 0;
  let result: IteratorResult<[SaxEventType, Detail]>;
  while (openTags >= 0 && !(result = await eventIter.next()).done) {
    const [evt, data] = result.value;
    if (evt === SaxEventType.CloseTag) {
      openTags--;
    }
    if (evt !== SaxEventType.OpenTag) {
      continue;
    }
    openTags++;
    const tag = data as Tag;
    if (tag.name === 'Polygon') {
      const points = getAttributeValue(tag, 'POINTS');
      if (!points) {
        logWithPosition(
          '<Polygon> without POINTS attribute, ignoring',
          'warn',
          tag,
        );
        continue;
      }
      polygon = points
        .split(' ')
        .map((p) => p.split(/(,| )/).map((c) => Number.parseFloat(c)))
        .reduce((acc, [c]) => {
          const lastElem: number[] | undefined = acc.slice(-1)[0];
          if (!lastElem || lastElem.length === 2) {
            acc.push([c]);
          } else {
            lastElem.push(c);
          }
          return acc;
        }, [] as number[][])
        .map(([x, y]) => ({ x: x * ctx.scaleFactor, y: y * ctx.scaleFactor }));
    }
  }
  const parent = ctx.elementStack.slice(-1)[0] as OcrBlock | OcrLine | OcrWord;
  if (parent.x < 0 || parent.y < 0 || parent.width < 0 || parent.height < 0) {
    if (polygon) {
      parent.x = Math.min(...polygon.map((p) => p.x));
      parent.y = Math.min(...polygon.map((p) => p.y));
      parent.width = Math.max(...polygon.map((p) => p.x)) - parent.x;
      parent.height = Math.max(...polygon.map((p) => p.y)) - parent.y;
    } else {
      throw new Error(
        `Could not get dimensions for ${parent.type}, no HPOS/VPOS/WIDTH/HEIGHT attribs and no associated Shape`,
      );
    }
  }
  return polygon;
}

async function handleWord(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  ctx: ParserContext,
  tag: Tag,
): Promise<void> {
  const dims = getCoordinates(tag);
  let text = getAttributeValue(tag, 'CONTENT');
  if (!text) {
    throw new Error('Could not get String text');
  }

  if (text.includes('&')) {
    text = resolveXmlEntities(text);
  }

  const word: OcrWord = {
    type: 'word',
    x: dims.x ? dims.x * ctx.scaleFactor : -1,
    y: dims.y ? dims.y * ctx.scaleFactor : -1,
    width: dims.width ? dims.width * ctx.scaleFactor : -1,
    height: dims.height ? dims.height * ctx.scaleFactor : -1,
    text,
  };
  ctx.elementStack.push(word);

  const subsType = getAttributeValue(tag, 'SUBS_TYPE');
  if (subsType === 'HypPart1') {
    word.hyphenStart = true;
  }

  const wordConfidence = getAttributeValue(tag, 'WC');
  if (wordConfidence !== undefined) {
    word.confidence = Number.parseFloat(wordConfidence);
  }

  let openTags = 0;
  let result: IteratorResult<[SaxEventType, Detail]>;
  while (openTags >= 0 && !(result = await eventIter.next()).done) {
    const [evt, data] = result.value;
    if (evt === SaxEventType.CloseTag) {
      openTags--;
      if ((data as Tag).name === 'ALTERNATIVE') {
        if (!('choices' in word)) {
          word.choices = [];
        }
        let altText = (data as Tag).textNodes
          .filter((t) => t.value.trim() !== '')
          .map((t) => t.value.trim())
          .join('');
        if (altText.includes('&')) {
          altText = resolveXmlEntities(altText);
        }
        word.choices!.push({
          text: altText,
        });
      }
    } else if (evt === SaxEventType.OpenTag) {
      openTags++;
      if ((data as Tag).name === 'Shape') {
        const polygon = await handleShape(eventIter, ctx, tag);
        openTags--;
        if (polygon != null) {
          word.polygon = polygon;
        }
      }
    }
  }
  const line = ctx.elementStack.slice(-2)[0] as OcrLine;
  line.children.push(word);
  ctx.elementStack.pop();
}

async function handleSourceImageInformation(
  eventIter: AsyncGenerator<[SaxEventType, Detail], any, unknown>,
  ctx: ParserContext,
  _tag: Tag,
): Promise<void> {
  let openTags = 0;
  let result: IteratorResult<[SaxEventType, Detail]>;
  ctx.sourceImageInformation = {};
  while (openTags >= 0 && !(result = await eventIter.next()).done) {
    const [evt, data] = result.value;
    const tag = data as Tag;
    if (evt === SaxEventType.CloseTag) {
      openTags--;
      if (tag.name === 'fileName') {
        ctx.sourceImageInformation.fileName = tag.textNodes
          .map((t) => t.value)
          .join('');
      } else if (tag.name === 'fileIdentifier') {
        let ident = tag.textNodes.map((t) => t.value).join('');
        const location = getAttributeValue(tag, 'fileIdentifierLocation');
        if (location) {
          ident = `${location}:${ident}`;
        }
        ctx.sourceImageInformation.fileIdentifier = ident;
      } else if (tag.name === 'documentIdentifier') {
        let ident = tag.textNodes.map((t) => t.value).join('');
        const location = getAttributeValue(tag, 'documentIdentifierLocation');
        if (location) {
          ident = `${location}:${ident}`;
        }
        ctx.sourceImageInformation.documentIdentifier = ident;
      }
    } else if (evt === SaxEventType.OpenTag) {
      openTags++;
    }
  }
}

/**
 * Parse an ALTO document.
 *
 * @param hocr The ALTO document to parse. Can be a `string`, a `Uint8Array` or
 *   a `ReadableStream`.
 * @param referenceSizes An array of dimensions for each page in the document,
 *   or a callback that returns the dimensions for a given page, based on its
 *   numerical index and its XML attributes. These dimensions can be used to
 *   scale all coordinates to a given reference frame in cases when the display
 *   resolution is different from the OCR resolution. A reference size might be
 *   required to obtain pixel coordinates, since in some documents the
 *   coordinates are expressed in non-pixel units.
 * @returns An async generator that yields `OcrPage` objects.
 */
export async function* parseAltoPages(
  alto: ReadableStream | Uint8Array | string,
  referenceSizes?: Dimensions[] | ReferenceSizeCallback,
): AsyncGenerator<OcrPage> {
  if (Array.isArray(referenceSizes)) {
    const sizeArr = referenceSizes;
    referenceSizes = (idx: number) => sizeArr[idx] ?? null;
  }
  const readable: ReadableStream<Uint8Array> =
    typeof alto === 'string' || alto instanceof Uint8Array
      ? toReadableStream(alto)
      : alto;
  const parser = await getParser(readable);
  const ctx: ParserContext = {
    scaleFactor: 1,
    elementStack: [],
  };
  const eventIter = parser.iterate();
  let result: IteratorResult<[SaxEventType, Detail]>;
  let pageIdx = 0;
  while (!(result = await eventIter.next()).done) {
    const [evt, data] = result.value;

    if (
      evt === SaxEventType.CloseTag &&
      (data as Tag).name === 'MeasurementUnit'
    ) {
      const unit = (data as Tag).textNodes[0].value.trim();
      if (unit !== 'pixel' && !referenceSizes) {
        throw new Error(`Measurement unit ${unit} requires a reference size.`);
      }
    }

    // Handlers advance the iterator themselves until they're done with their
    // respective element, this entry level just needs to recognize the
    // beginning of the page element and then hand over to the page handler
    // function.
    if (evt !== SaxEventType.OpenTag) {
      continue;
    }

    const tag = data as Tag;
    if (tag.name === 'Page') {
      const page = await handlePage(
        eventIter,
        ctx,
        data as Tag,
        referenceSizes?.(pageIdx, getAllAttributes(data as Tag)) ?? undefined,
      );
      if (page) {
        yield page;
        pageIdx++;
      }
    } else if (tag.name === 'sourceImageInformation') {
      await handleSourceImageInformation(eventIter, ctx, tag);
    }
  }
}

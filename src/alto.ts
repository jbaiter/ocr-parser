import { Detail, SaxEventType, Tag } from 'sax-wasm';
import {
  Dimensions,
  OcrBlock,
  OcrElement,
  OcrLine,
  OcrPage,
  OcrWord,
  WordChoice,
  makeBlock,
  makeLine,
  makePage,
} from './model';
import {
  getParser,
  toReadableStream,
  resolveXmlEntities,
  getAttributeValue,
  getAllAttributes,
} from './util';
import { ReferenceSizeCallback } from '.';

type ParserContext = {
  scaleFactor: number;
  elementStack: OcrElement[];
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
    width: dims.width * scaleFactorX,
    height: dims.height * scaleFactorX,
  });
  ctx.elementStack.push(page);

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
    if ((data as Tag).name !== 'TextBlock') {
      continue;
    }
    await handleBlock(eventIter, ctx, data as Tag);
  }
  ctx.elementStack.pop();
  return page;
}

async function handleBlock(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  ctx: ParserContext,
  tag: Tag,
): Promise<void> {
  const dims = getCoordinates(tag);
  if (!dims.width || !dims.height) {
    throw new Error('Could not get TextBlock dimensions');
  }
  const block = makeBlock({
    x: dims.x! * ctx.scaleFactor,
    y: dims.y! * ctx.scaleFactor,
    width: dims.width * ctx.scaleFactor,
    height: dims.height * ctx.scaleFactor,
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
    if ((data as Tag).name !== 'TextLine') {
      continue;
    }
    await handleLine(eventIter, ctx, data as Tag);
  }
  ctx.elementStack.pop();
}

async function handleLine(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  ctx: ParserContext,
  tag: Tag,
): Promise<void> {
  const dims = getCoordinates(tag);
  if (!dims.width || !dims.height) {
    throw new Error('Could not get Line dimensions');
  }
  const line = makeLine({
    x: dims.x! * ctx.scaleFactor,
    y: dims.y! * ctx.scaleFactor,
    width: dims.width * ctx.scaleFactor,
    height: dims.height * ctx.scaleFactor,
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
    if ((data as Tag).name === 'String') {
      await handleWord(eventIter, ctx, data as Tag);
      // Words handle their closing themselves
      openTags--;
    } else if ((data as Tag).name === 'SP') {
      line.children.push(' ');
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

async function handleWord(
  eventIter: AsyncIterableIterator<[SaxEventType, Detail]>,
  ctx: ParserContext,
  tag: Tag,
): Promise<void> {
  const dims = getCoordinates(tag);
  if (!dims.width || !dims.height) {
    throw new Error('Could not get String dimensions');
  }
  let text = getAttributeValue(tag, 'CONTENT');
  if (!text) {
    throw new Error('Could not get String text');
  }

  if (text.includes('&')) {
    text = resolveXmlEntities(text);
  }

  const word: OcrWord = {
    type: 'word',
    x: dims.x! * ctx.scaleFactor,
    y: dims.y! * ctx.scaleFactor,
    width: dims.width * ctx.scaleFactor,
    height: dims.height * ctx.scaleFactor,
    text,
  };

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
    }
  }
  const line = ctx.elementStack.slice(-1)[0] as OcrLine;
  line.children.push(word);
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

    if ((data as Tag).name === 'Page') {
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
    }
  }
}

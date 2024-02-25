import { parseHocrPages } from './hocr.js';
import { parseAltoPages } from './alto.js';
import { toReadableStream, isInitialized } from './util.js';
import { type Dimensions, type OcrPage } from './model.js';

export { parseHocrPages } from './hocr.js';
export { parseAltoPages } from './alto.js';
export { initialize, isInitialized, setupLogging, SAX_WASM_VERSION } from './util.js';
export type {
  Dimensions,
  Coordinates,
  PageLocation,
  WordChoice,
  OcrPage,
  OcrBlock,
  OcrParagraph,
  OcrLine,
  OcrWord,
  OcrFeature,
  OcrFeatures,
  ImageSource,
  Polygon,
} from './model';

/**
 * Callback to provide a reference size for a given page.
 *
 * @param idx: 0-based index of the page in the document.
 * @param pageAttribs: XML attributes of the page element.
 * @returns The reference size , or `null` if no reference size is available.
 */
export type ReferenceSizeCallback = (
  idx: number,
  pageAttribs: { [key: string]: string },
) => Dimensions | null;

/**
 * Parse a single OCR page in either ALTO or hOCR format.
 *
 * Must have run {@link initialize} first.
 *
 * @param markup The document to parse. Can be a `string`, a `Uint8Array` or a
 *   `ReadableStream`.
 * @param format The format of the document.
 * @param referenceSizes Reference page dimensions These dimensions can be used
 *   to scale all coordinates to a given reference frame in cases when the
 *   display resolution is different from the OCR resolution. In the case of
 *   ALTO, a reference size might be required to obtain pixel coordinates,
 *   since in some documents the coordinates are expressed in non-pixel units.
 * @returns An async generator that yields `OcrPage` objects.
 */
export async function parseOcrPage(
  /** HOCR/ALTO markup for a single page. */
  markup: string | ReadableStream | Uint8Array,
  format: 'hocr' | 'alto',
  referenceSize?: Dimensions,
): Promise<OcrPage> {
  if (!isInitialized()) {
    throw new Error(
      'XML parser WASM not initialized, call initialize() first!',
    );
  }
  let page: OcrPage | null;
  if (format === 'hocr') {
    page = (
      await parseHocrPages(
        markup,
        referenceSize ? [referenceSize] : undefined,
      ).next()
    ).value;
  } else if (format === 'alto') {
    page = (
      await parseAltoPages(
        markup,
        referenceSize ? [referenceSize] : undefined,
      ).next()
    ).value;
  } else {
    throw new Error(`Unsupported format: ${format}`);
  }
  if (!page) {
    throw new Error('Failed to parse page');
  }
  return page;
}

/**
 * Parse all OCR pages in the given hOCR or ALTO markup.
 *
 * Must have run {@link initialize} first.
 *
 * @param markup The document to parse. Can be a `string`, a `Uint8Array` or a
 *   `ReadableStream`.
 * @param format The format of the document.
 * @param referenceSizes An array of dimensions for each page in the document,
 *   or a callback that returns the dimensions for a given page, based on its
 *   numerical index and its XML attributes.These dimensions can be used to
 *   scale all coordinates to a given reference frame in cases when the display
 *   resolution is different from the OCR resolution. In the case of ALTO, a
 *   reference size might be required to obtain pixel coordinates, since in
 *   some documents the coordinates are expressed in non-pixel units.
 * @returns An async generator that yields `OcrPage` objects.
 */
export async function* parseOcrPages(
  markup: string | ReadableStream | Uint8Array,
  format: 'hocr' | 'alto',
  referenceSizes?: Dimensions[] | ReferenceSizeCallback,
): AsyncGenerator<OcrPage> {
  if (!isInitialized()) {
    throw new Error(
      'XML parser WASM not initialized, call initialize() first!',
    );
  }
  if (!(markup instanceof ReadableStream)) {
    markup = toReadableStream(markup);
  }
  switch (format) {
    case 'hocr':
      yield* parseHocrPages(markup, referenceSizes);
      break;
    case 'alto':
      yield* parseAltoPages(markup, referenceSizes);
      break;
  }
}

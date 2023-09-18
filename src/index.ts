import { parseHocrPage } from './hocr';
import { parseAltoPage } from './alto';
import { toReadableStream } from './util';
import { Dimensions, OcrPage } from './model';

export { parseHocrPage } from './hocr';
export { parseAltoPage } from './alto';
export { initialize } from './util';
export { OcrPage, OcrBlock, OcrParagraph, OcrLine, OcrWord } from './model';

export async function parseOcrPage(
  /** HOCR/ALTO markup for a single page. */
  markup: string | ReadableStream | Uint8Array,
  format: 'hocr' | 'alto',
  referenceSize: Dimensions,
): Promise<OcrPage> {
  switch (format) {
    case 'hocr':
      return await parseHocrPage(markup, referenceSize);
    case 'alto':
      return await parseAltoPage(markup, referenceSize);
  }
}

export async function parseOcrPages(
  markup: string | ReadableStream | Uint8Array,
  format: 'hocr' | 'alto',
  referenceSizes?: Dimensions[],
): Promise<OcrPage[]> {
  if (!(markup instanceof ReadableStream)) {
    markup = toReadableStream(markup);
  }
  // TODO:
  switch (format) {
    case 'hocr':
      throw new Error('Not Implemented Yet');
    case 'alto':
      throw new Error('Not Implemented Yet');
  }
}

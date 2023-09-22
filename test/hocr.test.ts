import fs from 'fs';
import { describe, test, expect, beforeAll } from 'vitest';
import { parseHocrPages, initialize } from '../src';

// Custom serializer that ignores getters
expect.addSnapshotSerializer({
  test: (val) =>
    typeof val === 'object' &&
    Object.values(Object.getOwnPropertyDescriptors(val)).some((d) => d.get),
  serialize(val, config, indentation, depth, refs, printer) {
    const filtered = Object.fromEntries(
      Object.entries(val).filter(
        ([k]) => !Object.getOwnPropertyDescriptor(val, k)?.get,
      ),
    );
    return printer(filtered, config, indentation, depth, refs);
  },
});

//@ts-expect-error
import WITH_EMPTY_LINE from './__fixtures__/hocr_emptyline.html?raw';

const makeHocr = (hocrBody: string) => `
<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
  <head>
    <title>Sample hOCR Document</title>
    <meta charset="UTF-8" />
    <meta name='ocr-system' content='tesseract 4.1.1' />
    <meta name='ocr-capabilities' content='ocr_page ocr_carea ocr_par ocr_line ocrx_word' />
  </head>
  <body>
  ${hocrBody}
  </body>
</html>
`;
const BASIC_HOCR = makeHocr(`
  <div class='ocr_page' id='page_1' title='image "sample.jpg"; bbox 0 0 800 600; ppageno 0'>
    <div class='ocr_carea' id='block_1_1' title="bbox 100 200 500 400">
      <p class='ocr_par' id='par_1_1' lang='eng'>
        <span class='ocr_line' id='line_1_1' title="bbox 100 200 500 220; baseline -0.053 -2">
          <span class='ocrx_word' id='word_1_1' title="bbox 100 200 150 220; x_wconf 94">Hello</span>
          <span class='ocrx_word' id='word_1_2' title="bbox 200 200 250 220; x_wconf 95">World,</span>
          <span class='ocrx_word' id='word_1_3' title="bbox 260 200 310 220; x_wconf 96">how</span>
          <span class='ocrx_word' id='word_1_4' title="bbox 320 200 370 220; x_wconf 97">are</span>
          <span class='ocrx_word' id='word_1_5' title="bbox 380 200 430 220; x_wconf 98">the</span>
          <span class='ocrx_word' id='word_1_5' title="bbox 400 200 450 220; x_wconf 98">Nightin\u00AD</span>
        </span>
        <span class="ocr_line" id="line_1_2" title="bbox 100 260 500 280; baseline -0.053 -2">
          <span class='ocrx_word' id='word_1_1' title="bbox 100 280 150 300; x_wconf 94">gales</span>
        </span>
      </p>
    </div>
  </div>
`);
const HOCR_WITH_ALTERNATIVES = makeHocr(`
    <div class="ocr_page" id="ID1" title="bbox 0 0 20145 26970; ppageno 0">
      <div class="ocrx_block" title="bbox 732 246 19674 1488">
        <span class="ocr_line" title="bbox 19326 246 19674 750">
          <span class="ocrx_word" title="bbox 19326 246 19674 750;x_conf 80.95">i</span>
        </span>
        <span class="ocr_line" title="bbox 744 720 795 1017">
          <span class="ocrx_word" title="bbox 744 720 795 1017;x_conf 95.24">IIi</span>
        </span>
        <span class="ocr_line" title="bbox 732 573 1344 1485">
          <span class="ocrx_word" title="bbox 732 846 795 1482;x_conf 95.24">IiI</span>
          <span class="ocrx_word" title="bbox 1272 573 1344 1485;x_conf 80.95">j</span>
        </span>
        <span class="ocr_line" title="bbox 732 1026 762 1482">
          <span class="ocrx_word" title="bbox 732 1026 762 1482;x_conf 80.95">I</span>
        </span>
        <span class="ocr_line" title="bbox 1200 1236 19398 1488">
          <span class="ocrx_word" title="bbox 1200 1236 1230 1488;x_conf 80.95">I</span>
          <span class="ocrx_word" title="bbox 1380 1242 1398 1374;x_conf 80.95">i</span>
          <span class="ocrx_word" title="bbox 2148 1314 2232 1452;x_conf 80.95">II</span>
          <span class="ocrx_word" title="bbox 7878 1305 8211 1422;x_conf 100.00">THE</span>
          <span class="ocrx_word" title="bbox 8373 1305 9267 1425;x_conf 100.00">STANDARD</span>
          <span class="ocrx_word" title="bbox 9504 1299 10068 1416;x_conf 100.00">OGDEN</span>
          <span class="ocrx_word" title="bbox 10254 1308 10722 1428;x_conf 95.24">
            <span class="alternatives">
              <ins class="alt">UTAH</ins>
              <del class="alt">UTAR</del>
              <del class="alt">VTA</del>
            </span>
          </span>
          <span class="ocrx_word" title="bbox 10917 1305 11820 1425;x_conf 100.00">SATURDAY</span>
          <span class="ocrx_word" title="bbox 12012 1302 12669 1440;x_conf 100.00">AUGUST</span>
          <span class="ocrx_word" title="bbox 12822 1326 12903 1446;x_conf 100.00">7</span>
          <span class="ocrx_word" title="bbox 13095 1320 13401 1446;x_conf 96.83">
            <span class="alternatives">
              <ins class="alt">1909</ins>
              <del class="alt">1900</del>
            </span>
          </span>
          <span class="ocrx_word" title="bbox 19326 1272 19398 1488;x_conf 80.95">j</span></span>
      </div>
    </div>
`);

const saxWasm = fs.readFileSync(
  __dirname + '/../node_modules/sax-wasm/lib/sax-wasm.wasm',
);

async function toArray<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const result: T[] = [];
  for await (let page of gen) {
    result.push(page);
  }
  return result;
}

describe('hOCR parser', () => {
  beforeAll(() => {
    initialize(() => Promise.resolve(new Uint8Array(saxWasm)));
  });
  test('should parse a simple hOCR document', async () => {
    const pages = await toArray(
      parseHocrPages(BASIC_HOCR, [{ width: 800, height: 600 }]),
    );
    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page).toMatchSnapshot();
    expect(page?.text).toEqual('Hello World, how are the Nightingales');
  });

  test('should be able to handle a hOCR doc with alternatives', async () => {
    const pages = await toArray(
      parseHocrPages(HOCR_WITH_ALTERNATIVES, [
        {
          width: 20145,
          height: 26970,
        },
      ]),
    );
    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page?.text).toMatchInlineSnapshot(
      '"i IIi IiI j I I i II THE STANDARD OGDEN UTAH SATURDAY AUGUST 7 1909 j"',
    );
    expect(page?.lines).toMatchSnapshot();
  });

  test('should be able to handle lines with only empty words', async () => {
    const pages = await toArray(parseHocrPages(WITH_EMPTY_LINE));
    expect(pages).toHaveLength(1);
    expect(pages[0].lines).toMatchSnapshot();
  });
});

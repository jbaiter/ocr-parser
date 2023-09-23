//@ts-expect-error
import WITH_ALTERNATIVES from './__fixtures__/chronicling_america.xml?raw';

import fs from 'fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { parseAltoPages, initialize } from '../src';

const WITH_SHAPE = `
<?xml version="1.0" encoding="UTF-8"?>
<alto xmlns="http://schema.ccs-gmbh.com/ALTO">
  <Description>
    <MeasurementUnit>pixel</MeasurementUnit>
    <sourceImageInformation>
      <fileName>shape.png</fileName>
    </sourceImageInformation>
  </Description>
  <Layout>
    <Page ID="ID1" HEIGHT="2560" WIDTH="1440" PHYSICAL_IMG_NR="1" PRINTED_IMG_NR="I">
      <PrintSpace HEIGHT="24453.0" WIDTH="19500.0" HPOS="294.0" VPOS="954.0" PC="0.93230003">
        <TextBlock ID="TextBlock4" HEIGHT="198" WIDTH="785" HPOS="318" VPOS="1456" >
          <TextLine ID="TextLine8">
            <Shape>
              <Polygon POINTS="325 1456 1023 1456 1023 1504 419 1504 419 1552 325 1552"/>
            </Shape>
            <String ID="String33" CONTENT="EEn" WC="0.82" CC="050">
              <Shape><Polygon POINTS="325 1456 419 1456 419 1552 325 1552"/></shape>
            </String>
            <SP ID="SP26" WIDTH="28" HPOS="472" VPOS="1456"/>
            <String ID="String34" CONTENT="F~iJJcher" HEIGHT="43" WIDTH="152"  HPOS="500" VPOS="1457" WC="0.82" CC="860001000"/>
          </TextLine>
        </TextBlock>
      </PrintSpace>
    </Page>
  </Layout>
</alto>
`;

const saxWasm = fs.readFileSync(
  __dirname + '/../node_modules/sax-wasm/lib/sax-wasm.wasm',
);

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

async function toArray<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const result: T[] = [];
  for await (let page of gen) {
    result.push(page);
  }
  return result;
}

describe('parseAltoPage', () => {
  beforeAll(() => {
    initialize(() => Promise.resolve(new Uint8Array(saxWasm)));
  });
  it('parses alto lines', async () => {
    const pages = await toArray(
      parseAltoPages(WITH_ALTERNATIVES, [
        {
          width: 6113,
          height: 5115,
        },
      ]),
    );
    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page?.text).toMatchInlineSnapshot(
      '"J a Ira mj iI tE1r 3 i c JiLas Edition THE WINCHESTER NEWS I her injuries wsis made Dr Reynolds an eye specialist after lite examina cents and GO of Henry C Hall average weight 1410 > ounds at 0 cents"',
    );
    expect(page).toMatchSnapshot();
  });

  it('parses alto lines with shapes', async () => {
    const pages = await toArray(parseAltoPages(WITH_SHAPE));
    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page?.text).toEqual('EEn F~iJJcher');
    expect(page).toMatchSnapshot();
  });

  it('parses alto without explicitly encoded spaces', async () => {
    const pages = await toArray(
      parseAltoPages(WITH_ALTERNATIVES.replace(/<SP.*?\/>/g, ''), [
        {
          width: 6113,
          height: 5115,
        },
      ]),
    );
    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page?.text).toEqual(
      'J a Ira mj iI tE1r 3 i c JiLas Edition THE WINCHESTER NEWS I her injuries wsis made Dr Reynolds an eye specialist after lite examina cents and GO of Henry C Hall average weight 1410 > ounds at 0 cents',
    );
    expect(page).toMatchSnapshot();
  });
});

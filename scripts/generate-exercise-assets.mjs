import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const outDir = path.resolve('assets/exercises-cartoon');

const palette = {
  bg: '#FFF8F1',
  card: '#F7EBDD',
  cardAccent: '#E7D5C4',
  shadow: '#E7D8C8',
  outline: '#5B463B',
  skin: '#F3C7A8',
  shirt: '#D9815B',
  shorts: '#7A9C8A',
  metal: '#7C858B',
  darkMetal: '#4F565C',
  accent: '#D6A653',
  mat: '#B9C8B2',
};

const stroke = `stroke="${palette.outline}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none"`;

function svg(parts) {
  return `<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="110" fill="${palette.bg}"/>
  <rect x="28" y="28" width="456" height="456" rx="92" fill="${palette.card}"/>
  <circle cx="110" cy="96" r="74" fill="${palette.cardAccent}" fill-opacity="0.7"/>
  <circle cx="420" cy="416" r="96" fill="${palette.mat}" fill-opacity="0.55"/>
  <path d="M74 408C140 390 214 382 296 382C372 382 428 390 450 400" stroke="${palette.shadow}" stroke-width="12" stroke-linecap="round"/>
  ${parts.join('\n  ')}
</svg>`;
}

function node(x, y, r = 14, fill = palette.skin) {
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" ${stroke.replace('fill="none"', '')}/>`;
}

function pill(x, y, w, h, fill) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w, h) / 2}" fill="${fill}"/>`;
}

function line(x1, y1, x2, y2) {
  return `<path d="M${x1} ${y1}L${x2} ${y2}" ${stroke}/>`;
}

function poly(points) {
  return `<path d="M${points.map(([x, y], i) => `${i === 0 ? '' : 'L'}${x} ${y}`).join(' ')}" ${stroke}/>`;
}

function arc(d) {
  return `<path d="${d}" ${stroke}/>`;
}

function bench(x, y, w = 150) {
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="18" rx="9" fill="${palette.darkMetal}"/>`,
    line(x + 28, y + 18, x + 12, y + 72),
    line(x + w - 28, y + 18, x + w - 12, y + 72),
  ];
}

function platform(x, y, w, h = 18, fill = palette.mat) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>`;
}

function dumbbell(x, y, scale = 1, vertical = false) {
  const bw = 42 * scale;
  const bh = 12 * scale;
  const pw = 10 * scale;
  const ph = 30 * scale;
  if (vertical) {
    return [
      `<rect x="${x - bh / 2}" y="${y - bw / 2}" width="${bh}" height="${bw}" rx="${bh / 2}" fill="${palette.darkMetal}"/>`,
      `<rect x="${x - ph / 2}" y="${y - bw / 2 - pw - ph}" width="${ph}" height="${pw}" rx="${pw / 2}" fill="${palette.metal}"/>`,
      `<rect x="${x - ph / 2}" y="${y + bw / 2 + pw}" width="${ph}" height="${pw}" rx="${pw / 2}" fill="${palette.metal}"/>`,
    ];
  }
  return [
    `<rect x="${x - bw / 2}" y="${y - bh / 2}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="${palette.darkMetal}"/>`,
    `<rect x="${x - bw / 2 - ph}" y="${y - pw / 2}" width="${pw}" height="${ph}" rx="${pw / 2}" fill="${palette.metal}"/>`,
    `<rect x="${x + bw / 2 + ph - pw}" y="${y - pw / 2}" width="${pw}" height="${ph}" rx="${pw / 2}" fill="${palette.metal}"/>`,
  ];
}

function barbell(x1, x2, y) {
  return [
    `<rect x="${x1}" y="${y - 7}" width="${x2 - x1}" height="14" rx="7" fill="${palette.darkMetal}"/>`,
    pill(x1 - 14, y - 34, 12, 68, palette.metal),
    pill(x1 - 32, y - 28, 12, 56, palette.metal),
    pill(x2 + 2, y - 34, 12, 68, palette.metal),
    pill(x2 + 20, y - 28, 12, 56, palette.metal),
  ];
}

function head(x, y) {
  return `<circle cx="${x}" cy="${y}" r="18" fill="${palette.skin}" stroke="${palette.outline}" stroke-width="8"/>`;
}

function joint(x, y) {
  return `<circle cx="${x}" cy="${y}" r="6" fill="${palette.outline}"/>`;
}

function body({ x, y, angle = 0, shirt = palette.shirt }) {
  return `<g transform="translate(${x} ${y}) rotate(${angle})">
    <rect x="-20" y="-24" width="40" height="54" rx="16" fill="${shirt}" stroke="${palette.outline}" stroke-width="8"/>
  </g>`;
}

function shorts({ x, y, angle = 0, color = palette.shorts }) {
  return `<g transform="translate(${x} ${y}) rotate(${angle})">
    <rect x="-19" y="-8" width="38" height="24" rx="10" fill="${color}" stroke="${palette.outline}" stroke-width="8"/>
  </g>`;
}

function limb(points, color = palette.skin) {
  const [start, ...rest] = points;
  const d = [`M${start[0]} ${start[1]}`];
  rest.forEach(([x, y]) => d.push(`L${x} ${y}`));
  return `<path d="${d.join(' ')}" stroke="${color}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function limbOutline(points) {
  const [start, ...rest] = points;
  const d = [`M${start[0]} ${start[1]}`];
  rest.forEach(([x, y]) => d.push(`L${x} ${y}`));
  return `<path d="${d.join(' ')}" ${stroke}/>`;
}

function person(spec) {
  const parts = [
    head(spec.head[0], spec.head[1]),
    body({ x: spec.body[0], y: spec.body[1], angle: spec.bodyAngle ?? 0 }),
    shorts({ x: spec.shorts[0], y: spec.shorts[1], angle: spec.shortsAngle ?? spec.bodyAngle ?? 0 }),
  ];

  for (const arm of spec.arms ?? []) {
    parts.push(limb(arm.points));
    parts.push(limbOutline(arm.points));
    arm.joints?.forEach(([x, y]) => parts.push(joint(x, y)));
  }

  for (const leg of spec.legs ?? []) {
    parts.push(limb(leg.points));
    parts.push(limbOutline(leg.points));
    leg.joints?.forEach(([x, y]) => parts.push(joint(x, y)));
  }

  return parts;
}

const assets = [
  {
    name: 'bench-press-cartoon',
    title: '卧推',
    draw() {
      return svg([
        ...barbell(108, 404, 176),
        ...bench(138, 272, 236),
        platform(108, 358, 304, 18, '#C8D4C1'),
        ...person({
          head: [176, 228],
          body: [226, 238],
          shorts: [274, 240],
          bodyAngle: 90,
          arms: [
            { points: [[236, 220], [236, 186], [202, 176]], joints: [[236, 186]] },
            { points: [[216, 258], [216, 194], [180, 176]], joints: [[216, 194]] },
          ],
          legs: [
            { points: [[296, 252], [340, 286], [362, 338]], joints: [[340, 286]] },
            { points: [[296, 228], [340, 248], [376, 294]], joints: [[340, 248]] },
          ],
        }),
      ]);
    },
  },
  {
    name: 'dumbbell-curl-cartoon',
    title: '哑铃弯举',
    draw() {
      return svg([
        platform(124, 372, 264, 20),
        ...person({
          head: [256, 154],
          body: [256, 214],
          shorts: [256, 252],
          arms: [
            { points: [[232, 204], [210, 236], [208, 278]], joints: [[210, 236]] },
            { points: [[280, 204], [302, 236], [304, 278]], joints: [[302, 236]] },
          ],
          legs: [
            { points: [[242, 272], [228, 324], [220, 374]], joints: [[228, 324]] },
            { points: [[270, 272], [284, 324], [292, 374]], joints: [[284, 324]] },
          ],
        }),
        ...dumbbell(208, 292, 0.95),
        ...dumbbell(304, 292, 0.95),
      ]);
    },
  },
  {
    name: 'barbell-squat-cartoon',
    title: '杠铃深蹲',
    draw() {
      return svg([
        platform(118, 394, 276, 18),
        ...barbell(150, 362, 126),
        ...person({
          head: [256, 136],
          body: [256, 196],
          shorts: [256, 236],
          arms: [
            { points: [[232, 188], [208, 162], [196, 138]], joints: [[208, 162]] },
            { points: [[280, 188], [304, 162], [316, 138]], joints: [[304, 162]] },
          ],
          legs: [
            { points: [[238, 252], [198, 302], [182, 394]], joints: [[198, 302]] },
            { points: [[274, 252], [314, 302], [330, 394]], joints: [[314, 302]] },
          ],
        }),
      ]);
    },
  },
  {
    name: 'tbar-row-cartoon',
    title: 'T杆划船',
    draw() {
      return svg([
        `<circle cx="338" cy="372" r="18" fill="${palette.metal}"/>`,
        `<rect x="194" y="328" width="162" height="14" rx="7" fill="${palette.darkMetal}" transform="rotate(18 194 328)"/>`,
        pill(314, 290, 16, 82, palette.metal),
        platform(124, 388, 264, 18),
        ...person({
          head: [248, 178],
          body: [240, 228],
          shorts: [234, 260],
          bodyAngle: 28,
          shortsAngle: 24,
          arms: [
            { points: [[258, 222], [286, 250], [302, 282]], joints: [[286, 250]] },
            { points: [[228, 208], [254, 242], [286, 278]], joints: [[254, 242]] },
          ],
          legs: [
            { points: [[214, 278], [188, 334], [170, 392]], joints: [[188, 334]] },
            { points: [[244, 290], [258, 338], [270, 392]], joints: [[258, 338]] },
          ],
        }),
      ]);
    },
  },
  {
    name: 'hip-bridge-cartoon',
    title: '臀桥',
    draw() {
      return svg([
        platform(118, 350, 276, 28),
        ...person({
          head: [176, 280],
          body: [248, 264],
          shorts: [294, 260],
          bodyAngle: -20,
          shortsAngle: -10,
          arms: [
            { points: [[212, 280], [188, 318], [168, 348]], joints: [[188, 318]] },
          ],
          legs: [
            { points: [[308, 276], [342, 314], [362, 352]], joints: [[342, 314]] },
            { points: [[286, 288], [314, 332], [320, 352]], joints: [[314, 332]] },
          ],
        }),
        `<rect x="214" y="240" width="108" height="16" rx="8" fill="${palette.darkMetal}"/>`,
        pill(206, 224, 16, 48, palette.metal),
        pill(322, 224, 16, 48, palette.metal),
      ]);
    },
  },
  {
    name: 'pull-up-cartoon',
    title: '引体向上',
    draw() {
      return svg([
        `<rect x="146" y="94" width="220" height="14" rx="7" fill="${palette.darkMetal}"/>`,
        line(176, 108, 156, 362),
        line(336, 108, 356, 362),
        platform(126, 366, 260, 18),
        ...person({
          head: [256, 182],
          body: [256, 244],
          shorts: [256, 282],
          arms: [
            { points: [[236, 226], [220, 174], [214, 108]], joints: [[220, 174]] },
            { points: [[276, 226], [292, 174], [298, 108]], joints: [[292, 174]] },
          ],
          legs: [
            { points: [[244, 302], [226, 342], [210, 380]], joints: [[226, 342]] },
            { points: [[268, 302], [286, 342], [302, 380]], joints: [[286, 342]] },
          ],
        }),
      ]);
    },
  },
  {
    name: 'lat-pulldown-cartoon',
    title: '高位下拉',
    draw() {
      return svg([
        line(146, 104, 146, 374),
        line(366, 104, 366, 374),
        `<rect x="146" y="104" width="220" height="12" rx="6" fill="${palette.darkMetal}"/>`,
        line(256, 110, 256, 168),
        `<rect x="210" y="162" width="92" height="12" rx="6" fill="${palette.darkMetal}"/>`,
        pill(192, 288, 128, 18, palette.darkMetal),
        line(210, 306, 182, 374),
        line(302, 306, 330, 374),
        ...person({
          head: [256, 190],
          body: [256, 248],
          shorts: [256, 284],
          arms: [
            { points: [[234, 232], [220, 200], [220, 168]], joints: [[220, 200]] },
            { points: [[278, 232], [292, 200], [292, 168]], joints: [[292, 200]] },
          ],
          legs: [
            { points: [[244, 304], [228, 338], [214, 378]], joints: [[228, 338]] },
            { points: [[268, 304], [284, 338], [298, 378]], joints: [[284, 338]] },
          ],
        }),
      ]);
    },
  },
  {
    name: 'dumbbell-row-cartoon',
    title: '哑铃划船',
    draw() {
      return svg([
        ...bench(118, 278, 160),
        platform(118, 356, 278, 18),
        ...person({
          head: [256, 170],
          body: [238, 220],
          shorts: [226, 254],
          bodyAngle: 26,
          shortsAngle: 18,
          arms: [
            { points: [[220, 216], [188, 250], [162, 278]], joints: [[188, 250]] },
            { points: [[256, 228], [290, 256], [320, 228]], joints: [[290, 256]] },
          ],
          legs: [
            { points: [[214, 274], [172, 310], [152, 356]], joints: [[172, 310]] },
            { points: [[246, 282], [266, 324], [282, 356]], joints: [[266, 324]] },
          ],
        }),
        ...dumbbell(324, 230, 0.95, true),
      ]);
    },
  },
  {
    name: 'seated-row-cartoon',
    title: '坐姿划船',
    draw() {
      return svg([
        line(378, 120, 378, 362),
        `<rect x="360" y="118" width="36" height="244" rx="18" fill="${palette.metal}"/>`,
        line(378, 166, 328, 220),
        `<rect x="312" y="214" width="34" height="12" rx="6" fill="${palette.darkMetal}"/>`,
        pill(168, 300, 120, 18, palette.darkMetal),
        platform(130, 360, 256, 18),
        ...person({
          head: [210, 196],
          body: [220, 250],
          shorts: [220, 286],
          bodyAngle: -8,
          arms: [
            { points: [[234, 236], [276, 226], [314, 220]], joints: [[276, 226]] },
            { points: [[242, 256], [284, 242], [314, 220]], joints: [[284, 242]] },
          ],
          legs: [
            { points: [[204, 304], [178, 336], [164, 372]], joints: [[178, 336]] },
            { points: [[232, 304], [256, 336], [272, 372]], joints: [[256, 336]] },
          ],
        }),
      ]);
    },
  },
  {
    name: 'pec-deck-fly-cartoon',
    title: '蝴蝶飞鸟',
    draw() {
      return svg([
        `<rect x="154" y="108" width="204" height="16" rx="8" fill="${palette.darkMetal}"/>`,
        line(186, 124, 186, 362),
        line(326, 124, 326, 362),
        pill(214, 288, 84, 18, palette.darkMetal),
        line(228, 306, 204, 374),
        line(284, 306, 306, 374),
        arc('M166 190C182 162 210 148 232 148'),
        arc('M346 190C330 162 302 148 280 148'),
        ...person({
          head: [256, 182],
          body: [256, 240],
          shorts: [256, 280],
          arms: [
            { points: [[234, 230], [206, 198], [184, 188]], joints: [[206, 198]] },
            { points: [[278, 230], [306, 198], [328, 188]], joints: [[306, 198]] },
          ],
          legs: [
            { points: [[244, 300], [226, 338], [212, 378]], joints: [[226, 338]] },
            { points: [[268, 300], [286, 338], [300, 378]], joints: [[286, 338]] },
          ],
        }),
      ]);
    },
  },
  {
    name: 'cable-chest-fly-cartoon',
    title: '龙门架夹胸',
    draw() {
      return svg([
        line(154, 110, 154, 372),
        line(358, 110, 358, 372),
        `<rect x="136" y="108" width="240" height="14" rx="7" fill="${palette.darkMetal}"/>`,
        pill(144, 168, 20, 54, palette.metal),
        pill(348, 168, 20, 54, palette.metal),
        line(154, 196, 204, 222),
        line(358, 196, 308, 222),
        platform(138, 374, 236, 18),
        ...person({
          head: [256, 168],
          body: [256, 228],
          shorts: [256, 266],
          arms: [
            { points: [[234, 218], [212, 232], [256, 248]], joints: [[212, 232]] },
            { points: [[278, 218], [300, 232], [256, 248]], joints: [[300, 232]] },
          ],
          legs: [
            { points: [[244, 286], [224, 330], [208, 382]], joints: [[224, 330]] },
            { points: [[268, 286], [288, 330], [304, 382]], joints: [[288, 330]] },
          ],
        }),
      ]);
    },
  },
  {
    name: 'treadmill-cartoon',
    title: '跑步机',
    draw() {
      return svg([
        platform(118, 386, 284, 18),
        `<path d="M164 324L318 292L330 308L176 340Z" fill="${palette.darkMetal}" stroke="${palette.outline}" stroke-width="8" stroke-linejoin="round"/>`,
        `<path d="M182 323L296 299" stroke="${palette.metal}" stroke-width="8" stroke-linecap="round"/>`,
        line(304, 224, 320, 314),
        line(246, 314, 320, 314),
        line(282, 212, 320, 182),
        `<rect x="310" y="160" width="42" height="30" rx="10" fill="${palette.metal}"/>`,
        `<rect x="319" y="169" width="24" height="12" rx="6" fill="${palette.accent}"/>`,
        ...person({
          head: [238, 154],
          body: [244, 214],
          shorts: [244, 252],
          bodyAngle: -8,
          arms: [
            { points: [[228, 208], [250, 194], [282, 190]], joints: [[250, 194]] },
            { points: [[266, 210], [286, 228], [304, 246]], joints: [[286, 228]] },
          ],
          legs: [
            { points: [[236, 272], [208, 308], [180, 334]], joints: [[208, 308]] },
            { points: [[260, 272], [286, 302], [334, 322]], joints: [[286, 302]] },
          ],
        }),
      ]);
    },
  },
  {
    name: 'stair-climber-cartoon',
    title: '爬楼机',
    draw() {
      return svg([
        platform(122, 390, 268, 18),
        line(184, 124, 168, 390),
        line(328, 124, 344, 390),
        `<rect x="164" y="120" width="184" height="14" rx="7" fill="${palette.darkMetal}"/>`,
        line(214, 152, 214, 246),
        line(298, 152, 298, 246),
        `<path d="M188 250L230 264L226 278L184 264Z" fill="${palette.metal}" stroke="${palette.outline}" stroke-width="8" stroke-linejoin="round"/>`,
        `<path d="M282 282L324 296L320 310L278 296Z" fill="${palette.metal}" stroke="${palette.outline}" stroke-width="8" stroke-linejoin="round"/>`,
        line(214, 246, 202, 316),
        line(298, 246, 310, 348),
        ...person({
          head: [256, 168],
          body: [256, 228],
          shorts: [256, 266],
          arms: [
            { points: [[234, 216], [224, 188], [214, 158]], joints: [[224, 188]] },
            { points: [[278, 216], [288, 188], [298, 158]], joints: [[288, 188]] },
          ],
          legs: [
            { points: [[244, 286], [226, 320], [208, 344]], joints: [[226, 320]] },
            { points: [[268, 286], [288, 312], [304, 374]], joints: [[288, 312]] },
          ],
        }),
      ]);
    },
  },
];

await fs.mkdir(outDir, { recursive: true });

const manifest = [];

for (const asset of assets) {
  const svgPath = path.join(outDir, `${asset.name}.svg`);
  const pngPath = path.join(outDir, `${asset.name}.png`);
  await fs.writeFile(svgPath, asset.draw(), 'utf8');
  await execFileAsync('convert', ['-background', 'none', '-resize', '512x512', svgPath, pngPath]);
  manifest.push({
    name: asset.title,
    svg: path.relative(process.cwd(), svgPath),
    png: path.relative(process.cwd(), pngPath),
  });
}

const readme = [
  '# Exercise Cartoon Assets',
  '',
  '统一风格的健身动作卡通 UI 素材，透明底 PNG + SVG 源文件。',
  '',
  ...manifest.flatMap((item) => [
    `- ${item.name}`,
    `  - ${item.svg}`,
    `  - ${item.png}`,
  ]),
  '',
].join('\n');

await fs.writeFile(path.join(outDir, 'README.md'), readme, 'utf8');

console.log(`Generated ${assets.length} exercise assets in ${path.relative(process.cwd(), outDir)}`);

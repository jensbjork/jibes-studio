// Made-up pictures for the README's demo library (scripts/screenshots.mjs): flat illustrations of one evening at a
// harbour, as SVG. Rendered to PNG inside the app's window (canvas) – nothing is generated and nothing comes from
// anyone's library. Wide pictures are 1280 × 720 (places and storyboard boards), tall ones 768 × 1024 (people, things).

const sky = (id, stops) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops
    .map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`)
    .join('')}</linearGradient>`

const glow = (id, colour) =>
  `<radialGradient id="${id}"><stop offset="0" stop-color="${colour}" stop-opacity="0.9"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></radialGradient>`

const wide = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs>${defs}</defs>${body}</svg>`
const tall = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024" viewBox="0 0 768 1024"><defs>${defs}</defs>${body}</svg>`

/** Pier lamps: a post and a warm glow at each x along the pier's rail. */
const lamps = (xs, top) =>
  xs
    .map(
      (x, i) =>
        `<circle cx="${x}" cy="${top - i * 6}" r="${46 - i * 6}" fill="url(#lamp)"/><rect x="${x - 2}" y="${top - i * 6}" width="4" height="${120 - i * 18}" fill="#141320"/><circle cx="${x}" cy="${top - i * 6}" r="${6 - i}" fill="#ffd9a0"/>`
    )
    .join('')

const harbourSky = sky('sky', [
  [0, '#141a33'],
  [0.45, '#4a2e55'],
  [0.78, '#c4605a'],
  [1, '#f4a25c']
])
const sea = sky('sea', [
  [0, '#2a2a45'],
  [1, '#0c0f1c']
])
const boat = (x, y, s) =>
  `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-60 0 L60 0 L42 22 L-44 22 Z" fill="#11111d"/><rect x="-4" y="-90" width="5" height="90" fill="#11111d"/><path d="M1 -86 L1 -10 L46 -10 Z" fill="#1b1a2b"/></g>`

/** The harbour at dusk: low sun, boats, the pier with its lamps coming on. */
const harbour = (figure = '') =>
  wide(
    `<rect width="1280" height="720" fill="url(#sky)"/>
    <circle cx="880" cy="430" r="70" fill="#ffcf8a" opacity="0.95"/>
    <rect y="440" width="1280" height="280" fill="url(#sea)"/>
    ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${820 - i * 14}" y="${452 + i * 22}" width="${120 + i * 28}" height="4" fill="#ffcf8a" opacity="${0.5 - i * 0.07}"/>`).join('')}
    ${boat(330, 470, 1.1)}${boat(560, 462, 0.7)}${boat(1120, 466, 0.85)}
    <path d="M0 610 L700 468 L716 472 L0 650 Z" fill="#1a1626"/>
    <path d="M0 650 L716 472 L716 480 L0 690 Z" fill="#0f0d18"/>
    ${lamps([120, 300, 470, 620], 520)}
    ${figure}`,
    harbourSky + sea + glow('lamp', '#ffb366')
  )

/** A woman in a yellow raincoat on the pier, small, by the second lamp. */
const figureOnPier = `<g transform="translate(372 470)"><path d="M-14 0 C-18 -40 -10 -70 0 -74 C10 -70 18 -40 14 0 Z" fill="#f2c230"/><circle cx="0" cy="-84" r="11" fill="#f2c230"/><circle cx="2" cy="-82" r="7" fill="#e9b48f"/><rect x="-9" y="0" width="5" height="20" fill="#1d1a26"/><rect x="4" y="0" width="5" height="20" fill="#1d1a26"/></g>`

/** The same figure from behind at the end of the pier, looking out to sea. */
const lookingOut = wide(
  `<rect width="1280" height="720" fill="url(#sky)"/>
  <circle cx="640" cy="440" r="90" fill="#ffcf8a" opacity="0.9"/>
  <rect y="440" width="1280" height="280" fill="url(#sea)"/>
  ${[0, 1, 2, 3, 4].map((i) => `<rect x="${560 - i * 20}" y="${456 + i * 24}" width="${160 + i * 40}" height="5" fill="#ffcf8a" opacity="${0.45 - i * 0.08}"/>`).join('')}
  <rect x="0" y="600" width="1280" height="120" fill="#120f1b"/>
  <rect x="0" y="560" width="1280" height="10" fill="#1d1928"/>
  ${[80, 300, 520, 760, 980, 1200].map((x) => `<rect x="${x}" y="560" width="10" height="60" fill="#1d1928"/>`).join('')}
  <g transform="translate(640 600)"><path d="M-60 0 C-70 -120 -46 -210 0 -220 C46 -210 70 -120 60 0 Z" fill="#f2c230"/><path d="M-38 -200 C-40 -260 40 -260 38 -200 C30 -230 -30 -230 -38 -200 Z" fill="#dca91f"/><path d="M-60 0 C-62 -40 -58 -80 -50 -110 L-40 -40 Z" fill="#d9a821"/></g>`,
  harbourSky + sea
)

/** The lighthouse on its cliff, its beam sweeping across low clouds. */
const lighthouse = wide(
  `<rect width="1280" height="720" fill="url(#night)"/>
  ${[
    [120, 80],
    [260, 140],
    [420, 60],
    [980, 90],
    [1110, 160],
    [760, 50],
    [600, 120]
  ]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2" fill="#f4eede" opacity="0.8"/>`)
    .join('')}
  <path d="M770 250 L1280 120 L1280 330 Z" fill="#ffe6a8" opacity="0.18"/>
  <path d="M0 300 C200 270 420 300 640 280 C860 260 1060 300 1280 280 L1280 330 C1000 350 760 320 520 340 C320 356 160 330 0 340 Z" fill="#2c3352" opacity="0.7"/>
  <rect y="470" width="1280" height="250" fill="url(#sea)"/>
  ${[0, 1, 2, 3].map((i) => `<path d="M${100 + i * 270} ${560 + i * 30} q40 -14 80 0 t80 0" stroke="#3d4b6e" stroke-width="3" fill="none"/>`).join('')}
  <path d="M520 720 L560 520 L660 470 L840 460 L940 500 L1000 720 Z" fill="#14121d"/>
  <rect x="728" y="260" width="64" height="210" fill="#efe8dc"/>
  <rect x="728" y="310" width="64" height="26" fill="#c94b48"/>
  <rect x="728" y="380" width="64" height="26" fill="#c94b48"/>
  <rect x="720" y="236" width="80" height="26" fill="#2a2433"/>
  <circle cx="760" cy="226" r="60" fill="url(#beam)"/>
  <rect x="736" y="206" width="48" height="30" fill="#ffe08f"/>
  <path d="M726 206 L760 176 L794 206 Z" fill="#2a2433"/>`,
  sky('night', [
    [0, '#0b1024'],
    [0.6, '#24305a'],
    [1, '#3e4a78']
  ]) +
    sky('sea', [
      [0, '#1d2744'],
      [1, '#090d1a']
    ]) +
    glow('beam', '#ffe08f')
)

/** A portrait: a soft background, a bust in its clothes, the face kept simple. */
const portrait = ({ bg, coat, collar, skin, hair }) =>
  tall(
    `<rect width="768" height="1024" fill="url(#bg)"/>
    <circle cx="384" cy="360" r="260" fill="#ffffff" opacity="0.05"/>
    <path d="M120 1024 C120 820 220 700 384 690 C548 700 648 820 648 1024 Z" fill="${coat}"/>
    <path d="M300 700 L384 800 L468 700 Z" fill="${collar}"/>
    <rect x="340" y="560" width="88" height="150" rx="30" fill="${skin}"/>
    <ellipse cx="384" cy="440" rx="130" ry="160" fill="${skin}"/>
    ${hair}`,
    sky('bg', bg)
  )

const mara = portrait({
  bg: [
    [0, '#23485a'],
    [1, '#0f1e29']
  ],
  coat: '#f2c230',
  collar: '#d6a61f',
  skin: '#e2b08c',
  hair: `<path d="M230 470 C200 260 300 230 384 230 C470 230 570 260 538 470 C520 360 470 320 384 318 C300 320 248 360 230 470 Z" fill="#2b1d1a"/><path d="M196 520 C170 300 260 180 384 176 C508 180 598 300 572 520 C560 420 540 330 500 300 L384 258 L268 300 C228 330 208 420 196 520 Z" fill="#f2c230"/>`
})
const theo = portrait({
  bg: [
    [0, '#4a3a2e'],
    [1, '#1c1611']
  ],
  coat: '#2f3c5a',
  collar: '#26314a',
  skin: '#d7a582',
  hair: `<path d="M262 360 C262 250 330 236 384 236 C440 236 506 250 506 360 C480 300 440 290 384 290 C330 290 290 300 262 360 Z" fill="#b9b4ac"/><path d="M270 470 C280 600 330 650 384 652 C440 650 488 600 498 470 C470 530 430 556 384 556 C338 556 298 530 270 470 Z" fill="#c9c4bb"/>`
})
const ines = portrait({
  bg: [
    [0, '#3c4b33'],
    [1, '#151b11']
  ],
  coat: '#4f7a46',
  collar: '#3e6338',
  skin: '#f0c4a4',
  hair: [
    [270, 330],
    [320, 270],
    [384, 250],
    [448, 270],
    [498, 330],
    [250, 410],
    [518, 410],
    [260, 490],
    [508, 490]
  ]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="58" fill="#c25a2c"/>`)
    .join('')
})

/** A red enamel coffee tin with a white label, as a packshot. */
const coffeeTin = tall(
  `<rect width="768" height="1024" fill="url(#bg)"/>
  <ellipse cx="384" cy="860" rx="230" ry="40" fill="#000" opacity="0.25"/>
  <rect x="184" y="300" width="400" height="560" fill="#c0392f"/>
  <ellipse cx="384" cy="860" rx="200" ry="36" fill="#a8302a"/>
  <rect x="184" y="300" width="60" height="560" fill="#d9483d"/>
  <ellipse cx="384" cy="300" rx="200" ry="36" fill="#e2564a"/>
  <ellipse cx="384" cy="300" rx="170" ry="26" fill="#b3352c"/>
  <rect x="184" y="470" width="400" height="200" fill="#f6efe2"/>
  <text x="384" y="565" font-family="Georgia, serif" font-size="70" text-anchor="middle" fill="#c0392f">CAFÉ</text>
  <text x="384" y="625" font-family="Helvetica, Arial, sans-serif" font-size="28" letter-spacing="8" text-anchor="middle" fill="#7a6a5a">HARBOUR ROAST</text>`,
  sky('bg', [
    [0, '#efe6d8'],
    [1, '#d6c8b2']
  ])
)

/** A yellow raincoat on a hanger. */
const raincoat = tall(
  `<rect width="768" height="1024" fill="url(#bg)"/>
  <path d="M384 150 C360 150 350 175 372 190 L384 200" stroke="#6d6a66" stroke-width="10" fill="none"/>
  <path d="M220 260 L384 200 L548 260 Z" fill="#7d6a52"/>
  <path d="M232 270 L300 250 C330 300 438 300 468 250 L536 270 L600 520 L540 540 L520 880 L248 880 L228 540 L168 520 Z" fill="#f2c230"/>
  <path d="M300 250 C330 300 438 300 468 250 C450 330 318 330 300 250 Z" fill="#d6a61f"/>
  <rect x="380" y="320" width="8" height="560" fill="#d6a61f"/>
  ${[400, 480, 560, 640, 720].map((y) => `<circle cx="404" cy="${y}" r="9" fill="#9a7a16"/>`).join('')}`,
  sky('bg', [
    [0, '#d9dde3'],
    [1, '#aeb6c2']
  ])
)

/** A figure at a railing, looking into the distance: the pose as a sketch. */
const pose = tall(
  `<rect width="768" height="1024" fill="#f3efe7"/>
  <g stroke="#3a3a46" stroke-width="10" stroke-linecap="round" fill="none">
    <line x1="80" y1="640" x2="700" y2="640"/><line x1="140" y1="640" x2="140" y2="900"/><line x1="620" y1="640" x2="620" y2="900"/>
    <circle cx="384" cy="300" r="56"/>
    <line x1="384" y1="356" x2="384" y2="620"/>
    <line x1="384" y1="420" x2="520" y2="640"/><line x1="384" y1="420" x2="300" y2="560"/>
    <line x1="384" y1="620" x2="330" y2="900"/><line x1="384" y1="620" x2="440" y2="900"/>
  </g>
  <path d="M440 300 L600 280" stroke="#c94b48" stroke-width="6" stroke-dasharray="14 12"/>`
)

/** Every picture by name, with its size class. */
export const DEMO_ART = {
  harbour: { svg: harbour(), wide: true },
  'mara-on-the-pier': { svg: harbour(figureOnPier), wide: true },
  'looking-out': { svg: lookingOut, wide: true },
  lighthouse: { svg: lighthouse, wide: true },
  mara: { svg: mara },
  theo: { svg: theo },
  ines: { svg: ines },
  'coffee-tin': { svg: coffeeTin },
  raincoat: { svg: raincoat },
  pose: { svg: pose }
}

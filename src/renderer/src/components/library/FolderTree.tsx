import type { ReactNode } from 'react'
import FolderIcon from './FolderIcon'
import type { RevealTarget } from './OpenFolderButton'

interface Entry {
  target: Exclude<RevealTarget, 'root'>
  name: string
  /** What the folder is for (settings). */
  explanation: string
  /** What its contents look like (setup screen). */
  example: (day: string, time: string) => string
}

// Names match the folders main creates (FOLDERS in src/main/paths.ts).
const ENTRIES: Entry[] = [
  {
    target: 'characters',
    name: 'Karaktärer',
    explanation: 'One folder per character with its reference photos, voice clips and description.',
    example: () => 'Anna/photo.jpg, Anna/voice.mp3, Anna/Beskrivning.txt'
  },
  {
    target: 'environments',
    name: 'Miljöer',
    explanation: 'One folder per environment with its reference images, sound clips and description.',
    example: () => 'Kitchen/evening.jpg, Kitchen/murmur.wav'
  },
  {
    target: 'products',
    name: 'Produkter',
    explanation: 'One folder per product with its product images and description.',
    example: () => 'Coffee tin/front.jpg'
  },
  {
    target: 'outfits',
    name: 'Kläder',
    explanation: 'One folder per outfit with its images and description.',
    example: () => 'Red dress/front.jpg'
  },
  {
    target: 'poses',
    name: 'Poser',
    explanation: 'One folder per pose with photos or sketches of the positions and its description.',
    example: () => 'Hug/sketch.png, Hug/Beskrivning.txt'
  },
  {
    target: 'references',
    name: 'Referensbilder',
    explanation: 'Start, end and reference images from elsewhere on your computer, copied here by day.',
    example: (day) => `${day}/start image.png`
  },
  {
    target: 'generations',
    name: 'Genereringar',
    explanation: 'Every video you generate, sorted by day and named after its prompt.',
    example: (day, time) => `${day}/${time} A cat on a roof.mp4`
  },
  {
    target: 'ownClips',
    name: 'Egna klipp',
    explanation: 'Your own films that you imported, by day. When a working copy is needed, the original sits next to it.',
    example: (day) => `${day}/Holiday.mov`
  },
  {
    target: 'sequences',
    name: 'Sekvenser',
    explanation: 'One folder per sequence with its takes and the finished, exported films.',
    example: () => 'My film/Tagningar/ and finished films'
  },
  {
    target: 'storyboards',
    name: 'Storyboards',
    explanation: 'One folder per storyboard with its images, the clips between them and the finished, exported films.',
    example: () => 'My storyboard/Bilder/, Övergångar/ and finished films'
  },
  {
    target: 'edits',
    name: 'Redigeringar',
    explanation: 'One folder per edit with its versions, new sound and the AI takes. The original is left untouched.',
    example: () => 'My film/My film v2 – Cut 0:02–0:04.mp4, Ljud/, Tagningar/'
  }
]

const HIDDEN = {
  name: '.studio',
  explanation: "The database and thumbnails. Hidden in Finder – don't change anything there.",
  example: 'hidden – database and thumbnails'
}

const pad = (n: number) => String(n).padStart(2, '0')

// Vertical centre of a row's first text line; the tree's ticks point there so wrapped rows still line up.
const TICK_TOP = 15

interface Props {
  /** Name shown at the top, e.g. the chosen folder's name. */
  rootName: string
  /** Shown next to the root name, e.g. the full path. */
  rootDetail?: string
  /** 'example' shows what files look like (setup); 'explain' says what each folder is for (settings). */
  detail: 'example' | 'explain'
  /** Makes the rows open their folder in Finder. */
  onOpen?: (target: RevealTarget) => void
}

/** The library's folder layout as a small tree. */
export default function FolderTree({ rootName, rootDetail, detail, onOpen }: Props) {
  const now = new Date()
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}.${pad(now.getMinutes())}`

  const rows = [
    ...ENTRIES.map((e) => ({
      key: e.target as string,
      name: e.name,
      text: detail === 'explain' ? e.explanation : e.example(day, time),
      target: e.target as RevealTarget | undefined
    })),
    { key: 'hidden', name: HIDDEN.name, text: detail === 'explain' ? HIDDEN.explanation : HIDDEN.example, target: undefined }
  ]

  return (
    <div className="text-[12px] leading-[18px]">
      <Row onClick={onOpen && (() => onOpen('root'))} title="Open the library folder in Finder">
        <FolderIcon size={14} className="mt-0.5 shrink-0 text-accent" />
        <span className="shrink-0 font-medium text-text">{rootName}</span>
        {rootDetail && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={rootDetail}>
            {rootDetail}
          </span>
        )}
      </Row>
      <ul>
        {rows.map((row, i) => {
          const last = i === rows.length - 1
          const hidden = !row.target
          return (
            <li key={row.key} className="relative pl-6">
              {/* Tree lines: a vertical spine (ending at the last folder) and a tick to each folder. */}
              <span
                className="absolute left-[15px] w-px bg-line"
                style={{ top: i === 0 ? -6 : 0, ...(last ? { height: TICK_TOP } : { bottom: 0 }) }}
              />
              <span className="absolute left-[15px] h-px w-3.5 bg-line" style={{ top: TICK_TOP }} />
              <Row
                onClick={onOpen && row.target ? () => onOpen(row.target!) : undefined}
                title={`Open “${row.name}” in Finder`}
              >
                <FolderIcon size={13} className={`mt-0.5 shrink-0 ${hidden ? 'text-muted/50' : 'text-muted'}`} />
                <span className={`w-28 shrink-0 ${hidden ? 'text-muted' : 'text-text'}`}>{row.name}</span>
                <span
                  className={`min-w-0 flex-1 text-muted ${detail === 'example' ? 'font-mono text-[11px]' : ''} ${
                    hidden ? 'opacity-70' : ''
                  }`}
                >
                  {row.text}
                </span>
              </Row>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Row({ onClick, title, children }: { onClick?: () => void; title: string; children: ReactNode }) {
  const layout = 'flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-left'
  if (!onClick) return <div className={layout}>{children}</div>
  return (
    <button type="button" onClick={onClick} title={title} className={`group ${layout} transition hover:bg-raised`}>
      {children}
      <span className="shrink-0 text-[11px] text-muted opacity-0 transition group-hover:opacity-100">Open</span>
    </button>
  )
}

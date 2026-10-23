// The image dialogs and still components, for storyboards (board images) and sequences (keyframes):
//   <CreateImageDialog open sequenceId?={sequence or storyboard id} initialPrompt? previousImagePath?
//                      assign?={{ boardId } | { segmentId, slot }} onClose onCreated?(still) onBoardAssigned? />
//     With { boardId } every new image is put on the board (updateBoard) unless the board got another image
//     meanwhile; previousImagePath starts as the first reference (the base, labelled Previous): its ✕ takes it
//     out, "＋ Previous board's image" brings it back.
//   <FramePickerDialog open sequenceId? anyGeneration? generationId? segment? at? onClose onPicked(still) />
//     anyGeneration: any finished video in the library, with a search; else the sequence's takes.
//   <StillThumb still onOpen? draggable />  (drag payload STILL_DRAG_TYPE = still id)
//   <StillViewer still? stills? onClose deletable? actions? openedByAgent? />

export { CreateImageDialog, type CreateImageDialogProps, type CreateImageTarget } from './CreateImageDialog'
export { FramePickerDialog, type FramePickerDialogProps } from './FramePickerDialog'
export { StillThumb, STILL_DRAG_TYPE, isStillDrag, stillIdFromDrop } from './StillThumb'
export { StillViewer } from './StillViewer'
export {
  DEFAULT_IMAGE_MODEL,
  formatImagePrice,
  loadImageModels,
  plainImagePrompt,
  stillSourceLabel,
  useImageModels,
  useStillQuote,
  useStills
} from './imageModels'

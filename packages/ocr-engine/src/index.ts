// Pure core: safe to import anywhere (domains, tests). No native modules.
export * from './types';
export { coerce, describeSchema, extractJson, toJsonSchema } from './schema';
export { columnSlice, stripCount, tileRects, toPixels } from './geometry';
export {
  buildPrompt,
  columnLayout,
  nextAttempt,
  resultsFor,
  runTemplate,
  withRegionOverrides,
  type ColumnLayout,
  type RunOptions,
} from './pipeline';
export { DEFAULT_MODEL_ID, MODEL_CATALOG, getModel, type ModelFile, type ModelSpec } from './models';
export { anchorText, anchorsFrom, applyAffine, fitPerspective, isPerspective, mapRect, matchLayout, type Affine, type Anchor, type LayoutMatch } from './align';
export {
  alignParts as alignTemplateParts,
  anchorsForTemplate,
  bandOf,
  builtinTemplate,
  fullRect,
  isBandPart,
  isUsable,
  markedParts,
  matchLibrary,
  newTemplate,
  normalizeTemplate,
  placeFromHeadings,
  recognizeForm,
  specOf,
  suggestParts,
  templateForPhoto,
  unmarkedParts,
  variantOf,
  type Band,
  type BuiltinLayout,
  type HomeAt,
  type Recognition,
  type SheetLayout,
  type Catalog,
  type LibraryMatch,
  type PartCheck,
  type PartGroupSpec,
  type PartShape,
  type PartSpec,
  type PartStatus,
  type PartVariant,
  type Placement,
  type SportModule,
  type Template,
  type TemplateSource,
} from './templates';

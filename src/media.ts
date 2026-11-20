import { extname } from "node:path"

/** What a decision model can be shown besides text. */
export type MediaKind = "image" | "audio" | "video"

export const mediaKinds: ReadonlyArray<MediaKind> = ["image", "audio", "video"]

/** What a message calls several files of a kind. */
export const mediaNoun: Record<MediaKind, string> = { image: "images", audio: "audio clips", video: "videos" }

// A file's type is its extension's. These are the types of each kind that every decision API taking the
// kind accepts: Clef and OpenAI Decisions take PNG, JPEG, and WebP images; clef-omni and Gemini Decisions
// take these audio and video types too.
const types: Record<string, { readonly type: string; readonly kind: MediaKind }> = {
  ".png": { type: "image/png", kind: "image" },
  ".jpg": { type: "image/jpeg", kind: "image" },
  ".jpeg": { type: "image/jpeg", kind: "image" },
  ".webp": { type: "image/webp", kind: "image" },
  ".wav": { type: "audio/wav", kind: "audio" },
  ".mp3": { type: "audio/mpeg", kind: "audio" },
  ".flac": { type: "audio/flac", kind: "audio" },
  ".ogg": { type: "audio/ogg", kind: "audio" },
  ".mp4": { type: "video/mp4", kind: "video" },
  ".webm": { type: "video/webm", kind: "video" }
}

/** The extensions a media file may have, for messages. */
export const mediaExtensions = Object.keys(types)

/** A media file's MIME type and kind, from its extension; `undefined` when it isn't one the models take. */
export const mediaTypeOf = (path: string) => types[extname(path).toLowerCase()]

// Every model gets the same limits, so a policy's items are judged alike whichever model judges them. They
// are the smallest documented: Clef takes at most 4 images, each at most 4 MiB and 8 MiB together, and
// Workers AI takes a request body of at most 13 MiB, which 8 MiB of media fits in base64 with the text;
// clef-omni takes at most 4 audio clips and 2 videos.

/** Most files of each kind one item may show the model. */
export const maxMediaFiles: Record<MediaKind, number> = { image: 4, audio: 4, video: 2 }
/** Largest image an item may show the model. */
export const maxImageBytes = 4 * 1024 * 1024
/** Largest total of the media one item shows the model. */
export const maxMediaBytes = 8 * 1024 * 1024

/** A media file as read for a request: its type and kind, its size, and the SHA-256 of its contents. */
export interface Medium {
  readonly path: string
  readonly type: string
  readonly kind: MediaKind
  readonly bytes: number
  readonly digest: string
}

/** Reads the media file at `path` (which must have a media type) and fingerprints it; rejects if it can't. */
export const readMedium = async (path: string): Promise<Medium> => {
  const { type, kind } = mediaTypeOf(path)!
  const data = await Bun.file(path).bytes()
  return { path, type, kind, bytes: data.length, digest: new Bun.CryptoHasher("sha256").update(data).digest("hex") }
}

/** A media file's contents in base64, read when its request is sent. */
export const mediaBase64 = async (medium: Medium) => Buffer.from(await Bun.file(medium.path).bytes()).toString("base64")

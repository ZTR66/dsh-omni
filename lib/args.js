/**
 * Accept the parameter name a caller most likely used.
 *
 * The media tools all name their primary argument `input`, and their schema
 * describes it as "Path to a video file". A model reading that writes
 * `file_path`, `path` or `file` — never `input`, because the description names
 * the value and not the key. The result is a working tool that reports
 * "input is required", which reads as broken tooling rather than a naming
 * mistake.
 *
 * One recorded session did exactly that, decided the media layer was defective,
 * and spent the rest of its budget reimplementing frame extraction with ffmpeg
 * and librosa. The tools were fine.
 *
 * Accepting the four plausible spellings costs nothing and removes the whole
 * failure mode. `input` still wins when present, so nothing changes for a
 * caller that read the schema correctly.
 *
 * @param {object} args the raw arguments object
 * @returns {object} a shallow copy with `input` filled in when a synonym was used
 */
export function normaliseFileArg(args) {
  if (args === null || typeof args !== 'object') return args;
  if (typeof args.input === 'string' && args.input !== '') return args;

  for (const key of ['file_path', 'filepath', 'path', 'file', 'source', 'video', 'audio']) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') {
      return { ...args, input: value };
    }
  }
  return args;
}

/**
 * The same idea for the tools that take several files.
 *
 * `audio_cut` reads `inputs` when joining and `input` when cutting; a caller
 * that passes `files` or `paths` gets the same silent "not found" otherwise.
 */
export function normaliseFileListArg(args) {
  if (args === null || typeof args !== 'object') return args;
  if (Array.isArray(args.inputs) && args.inputs.length > 0) return args;

  for (const key of ['files', 'paths', 'sources']) {
    const value = args[key];
    if (Array.isArray(value) && value.length > 0) {
      return { ...args, inputs: value.map(String) };
    }
  }
  return args;
}

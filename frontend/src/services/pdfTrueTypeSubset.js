// Compatibility fixes for @pdf-lib/fontkit 1.1.1's TrueType subset encoder.
// Keep these isolated from node_modules and verify serialized glyphs/rendering
// when upgrading fontkit: they depend on its TTFSubset/TTFGlyphEncoder hooks.
export function fixTrueTypeSubset(font) {
  if (!font.directory?.tables?.glyf) return font;
  const createSubset = font.createSubset.bind(font);
  font.createSubset = () => {
    const subset = createSubset();
    const encoder = subset.glyphEncoder;
    const encodeSimple = encoder.encodeSimple.bind(encoder);
    encoder.encodeSimple = (path, instructions) => {
      const flags = [];
      const encodePoint = encoder._encodePoint;
      encoder._encodePoint = (...args) => {
        const flag = encodePoint.apply(encoder, args);
        if (args[4] === 4) flags.push(flag); // Y_SHORT_VECTOR: final flag for this point
        return flag;
      };
      let data;
      try { data = encodeSimple(path, instructions); }
      finally { encoder._encodePoint = encodePoint; }

      // encodeSimple omits the final repeat-count byte if a glyph ends with
      // repeated flags (e.g. D/P). Readers then consume coordinates as flags.
      // Preserve its point encoding but write explicit, uncompressed flags.
      let oldFlagLength = 0, repeated = 0, previous = 0, coordinateLength = 0;
      for (const flag of flags) {
        if (flag === previous && repeated < 255) repeated++;
        else {
          if (repeated) { oldFlagLength++; repeated = 0; }
          oldFlagLength++;
          previous = flag;
        }
        coordinateLength += flag & 2 ? 1 : flag & 16 ? 0 : 2;
        coordinateLength += flag & 4 ? 1 : flag & 32 ? 0 : 2;
      }
      const contours = data[0] * 256 + data[1];
      const instructionOffset = 10 + contours * 2;
      const instructionLength = data[instructionOffset] * 256 + data[instructionOffset + 1];
      const flagOffset = instructionOffset + 2 + instructionLength;
      const coordinateOffset = flagOffset + oldFlagLength;
      const length = flagOffset + flags.length + coordinateLength;
      const corrected = data.constructor.alloc(Math.ceil(length / 4) * 4);
      corrected.set(data.subarray(0, flagOffset));
      corrected.set(flags, flagOffset);
      corrected.set(data.subarray(coordinateOffset, coordinateOffset + coordinateLength), flagOffset + flags.length);
      return corrected;
    };

    const addGlyph = subset._addGlyph.bind(subset);
    subset._addGlyph = (id) => {
      const index = addGlyph(id);
      const data = subset.glyf[index];
      // Compound glyphs can still be copied raw, with odd byte lengths.
      // Align before the next short-loca offset is recorded (offset / 2).
      if (data.length % 2) {
        const padded = data.constructor.alloc(data.length + 1);
        padded.set(data);
        subset.glyf[index] = padded;
        subset.offset += 1;
      }
      return index;
    };
    return subset;
  };
  return font;
}
